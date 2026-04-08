const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ─── Config ────────────────────────────────────────────────────────────────
const config = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || null,
  BOOKSHELF_URL: process.env.BOOKSHELF_URL, // e.g. http://bookshelf:8787
  BOOKSHELF_API_KEY: process.env.BOOKSHELF_API_KEY,
  REQUEST_CHANNEL_ID: process.env.REQUEST_CHANNEL_ID || null, // optional: restrict to one channel
  ADMIN_ROLE_ID: process.env.ADMIN_ROLE_ID || null, // optional: role that can approve/deny
  LOG_FILE: process.env.LOG_FILE || "/config/librarian.log",
  REQUIRE_APPROVAL: process.env.REQUIRE_APPROVAL === "true", // if true, admin must approve requests
};

// ─── Logger ────────────────────────────────────────────────────────────────
const logDir = path.dirname(config.LOG_FILE);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, message, ...(data && { data }) };
  const line = JSON.stringify(entry);
  fs.appendFileSync(config.LOG_FILE, line + "\n");
  console.log(`[${timestamp}] [${level}] ${message}`, data || "");
}

// ─── Bookshelf API ─────────────────────────────────────────────────────────
const bsApi = axios.create({
  baseURL: `${config.BOOKSHELF_URL}/api/v1`,
  headers: { "X-Api-Key": config.BOOKSHELF_API_KEY },
  timeout: 10000,
});

async function searchBooks(term) {
  log("INFO", "Searching Bookshelf", { term });
  const res = await bsApi.get("/book/lookup", { params: { term } });
  return res.data.slice(0, 10); // max 10 results
}

async function getAuthor(foreignAuthorId) {
  const res = await bsApi.get("/author/lookup", {
    params: { term: foreignAuthorId },
  });
  return res.data[0] || null;
}

async function addBook(book) {
  log("INFO", "Adding book to Bookshelf", {
    title: book.title,
    author: book.author?.authorName,
  });

  // First ensure author exists
  let authorRes;
  try {
    const authorSearch = await bsApi.get("/author/lookup", {
      params: { term: book.author?.authorName || "" },
    });
    const matchedAuthor = authorSearch.data.find(
      (a) => a.foreignAuthorId === book.author?.foreignAuthorId
    );

    if (matchedAuthor) {
      try {
        authorRes = await bsApi.post("/author", {
          foreignAuthorId: matchedAuthor.foreignAuthorId,
          qualityProfileId: 1,
          metadataProfileId: 1,
          rootFolderPath: await getRootFolder(),
          monitored: true,
          monitorNewItems: "none",
          addOptions: { monitor: "none" },
        });
      } catch (e) {
        // Author may already exist
        const existing = await bsApi.get("/author");
        authorRes = existing.data.find(
          (a) => a.foreignAuthorId === matchedAuthor.foreignAuthorId
        );
      }
    }
  } catch (e) {
    log("WARN", "Author lookup failed, proceeding", { error: e.message });
  }

  // Add the book
  const rootFolder = await getRootFolder();
  const payload = {
    title: book.title,
    foreignBookId: book.foreignBookId,
    monitored: true,
    anyEditionOk: true,
    author: {
      foreignAuthorId: book.author?.foreignAuthorId,
      qualityProfileId: 1,
      metadataProfileId: 1,
      rootFolderPath: rootFolder,
      monitored: true,
      monitorNewItems: "none",
      addOptions: { monitor: "none" },
    },
    editions: book.editions,
    addOptions: {
      searchForNewBook: true,
    },
  };

  const res = await bsApi.post("/book", payload);
  log("INFO", "Book added successfully", { title: book.title, id: res.data.id });
  return res.data;
}

async function getRootFolder() {
  const res = await bsApi.get("/rootfolder");
  if (!res.data || res.data.length === 0) throw new Error("No root folders configured in Bookshelf");
  return res.data[0].path;
}

async function triggerSearch(bookId) {
  log("INFO", "Triggering search", { bookId });
  await bsApi.post("/command", { name: "BookSearch", bookIds: [bookId] });
}

async function getQueue() {
  const res = await bsApi.get("/queue");
  return res.data;
}

async function getLibrary() {
  const res = await bsApi.get("/book");
  return res.data;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function bookEmbed(book, status = null, requester = null) {
  const cover = book.remoteCover || book.editions?.[0]?.remoteCover || null;
  const author = book.author?.authorName || book.authorTitle || "Unknown Author";
  const rating = book.ratings?.value ? `⭐ ${book.ratings.value.toFixed(1)}/5` : "";
  const pages = book.editions?.[0]?.pageCount ? `📄 ${book.editions[0].pageCount} pages` : "";
  const year = book.releaseDate ? new Date(book.releaseDate).getFullYear() : "";

  const embed = new EmbedBuilder()
    .setTitle(book.title)
    .setAuthor({ name: author })
    .setColor(status === "approved" ? 0x00ff00 : status === "denied" ? 0xff0000 : status === "pending" ? 0xffa500 : 0x5865f2)
    .setFooter({ text: "Librarian" })
    .setTimestamp();

  if (cover) embed.setThumbnail(cover);
  if (book.overview) embed.setDescription(book.overview.slice(0, 300) + (book.overview.length > 300 ? "..." : ""));

  const fields = [];
  if (year) fields.push({ name: "Year", value: String(year), inline: true });
  if (rating) fields.push({ name: "Rating", value: rating, inline: true });
  if (pages) fields.push({ name: "Length", value: pages, inline: true });
  if (status) fields.push({ name: "Status", value: status.charAt(0).toUpperCase() + status.slice(1), inline: true });
  if (requester) fields.push({ name: "Requested by", value: requester, inline: true });
  if (fields.length) embed.addFields(fields);

  return embed;
}

function isAdmin(member) {
  if (!config.ADMIN_ROLE_ID) return member.permissions.has(PermissionFlagsBits.Administrator);
  return member.roles.cache.has(config.ADMIN_ROLE_ID);
}

// ─── Pending requests store (in-memory + persisted to JSON) ────────────────
const PENDING_FILE = "/config/pending-requests.json";
let pendingRequests = {};

function loadPending() {
  try {
    if (fs.existsSync(PENDING_FILE)) {
      pendingRequests = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
    }
  } catch (e) {
    log("WARN", "Could not load pending requests", { error: e.message });
  }
}

function savePending() {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(pendingRequests, null, 2));
  } catch (e) {
    log("ERROR", "Could not save pending requests", { error: e.message });
  }
}

loadPending();

// ─── Discord Client ────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ─── Register Commands ─────────────────────────────────────────────────────
const { REST, Routes } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("request")
    .setDescription("Request an audiobook")
    .addStringOption((o) =>
      o.setName("title").setDescription("Book title or author to search").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Check the download queue and recent additions"),
  new SlashCommandBuilder()
    .setName("library")
    .setDescription("Search the existing library")
    .addStringOption((o) =>
      o.setName("query").setDescription("Book title to search for").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("pending")
    .setDescription("View pending requests (admin only)"),
  new SlashCommandBuilder()
    .setName("logs")
    .setDescription("View recent bot logs (admin only)"),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
  try {
    log("INFO", "Registering slash commands...");
    const route = config.DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID)
      : Routes.applicationCommands(config.DISCORD_CLIENT_ID);
    await rest.put(route, { body: commands });
    log("INFO", "Slash commands registered");
  } catch (e) {
    log("ERROR", "Failed to register commands", { error: e.message });
  }
}

// ─── Interaction Handler ───────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  // ── Channel restriction ──
  if (config.REQUEST_CHANNEL_ID && interaction.channelId !== config.REQUEST_CHANNEL_ID) {
    if (interaction.isChatInputCommand()) {
      return interaction.reply({
        content: `❌ Please use <#${config.REQUEST_CHANNEL_ID}> for book requests.`,
        ephemeral: true,
      });
    }
  }

  // ── /request ──
  if (interaction.isChatInputCommand() && interaction.commandName === "request") {
    const query = interaction.options.getString("title");
    log("INFO", "Request command", { user: interaction.user.tag, query });

    await interaction.deferReply();

    try {
      const results = await searchBooks(query);

      if (!results.length) {
        log("INFO", "No results found", { query });
        return interaction.editReply({ content: `❌ No results found for **${query}**. Try a different search term.` });
      }

      // Check if any are already in library
      const library = await getLibrary();
      const libraryIds = new Set(library.map((b) => b.foreignBookId));

      const filtered = results.filter((b) => !libraryIds.has(b.foreignBookId));
      const alreadyHave = results.filter((b) => libraryIds.has(b.foreignBookId));

      if (alreadyHave.length && !filtered.length) {
        return interaction.editReply({
          content: `✅ We already have **${alreadyHave[0].title}** in the library! Check Audiobookshelf.`,
        });
      }

      // Build select menu
      const options = filtered.slice(0, 10).map((book, i) => {
        const author = book.author?.authorName || "Unknown";
        const year = book.releaseDate ? new Date(book.releaseDate).getFullYear() : "";
        return {
          label: book.title.slice(0, 100),
          description: `${author}${year ? ` (${year})` : ""}`.slice(0, 100),
          value: String(i),
        };
      });

      const select = new StringSelectMenuBuilder()
        .setCustomId(`select_book_${interaction.user.id}`)
        .setPlaceholder("Select a book to request")
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(select);

      // Store results temporarily
      pendingRequests[`search_${interaction.user.id}`] = {
        results: filtered.slice(0, 10),
        timestamp: Date.now(),
      };
      savePending();

      const embeds = filtered.slice(0, 1).map((b) => bookEmbed(b));

      await interaction.editReply({
        content: `Found **${filtered.length}** result(s) for **${query}**. Select a book below:`,
        embeds,
        components: [row],
      });
    } catch (e) {
      log("ERROR", "Request command failed", { error: e.message });
      await interaction.editReply({ content: `❌ Error searching Bookshelf: ${e.message}` });
    }
  }

  // ── Select menu ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("select_book_")) {
    const userId = interaction.customId.replace("select_book_", "");

    if (interaction.user.id !== userId) {
      return interaction.reply({ content: "❌ This menu is not for you.", ephemeral: true });
    }

    const searchKey = `search_${userId}`;
    const stored = pendingRequests[searchKey];
    if (!stored) {
      return interaction.reply({ content: "❌ Search expired. Please run `/request` again.", ephemeral: true });
    }

    const index = parseInt(interaction.values[0]);
    const book = stored.results[index];

    log("INFO", "Book selected", { user: interaction.user.tag, title: book.title });

    await interaction.deferUpdate();

    if (config.REQUIRE_APPROVAL && !isAdmin(interaction.member)) {
      // Store as pending approval
      const requestId = `req_${Date.now()}_${userId}`;
      pendingRequests[requestId] = {
        book,
        requester: interaction.user.tag,
        requesterId: userId,
        timestamp: Date.now(),
        status: "pending",
      };
      delete pendingRequests[searchKey];
      savePending();

      log("INFO", "Request pending approval", { requestId, title: book.title, requester: interaction.user.tag });

      const embed = bookEmbed(book, "pending", interaction.user.tag);
      const approveRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_${requestId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`deny_${requestId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
      );

      await interaction.editReply({
        content: `📋 **Request submitted for approval!** An admin will review your request for **${book.title}**.`,
        embeds: [embed],
        components: [],
      });

      // Notify admins if there's a request channel
      if (config.REQUEST_CHANNEL_ID) {
        const channel = await client.channels.fetch(config.REQUEST_CHANNEL_ID);
        await channel.send({
          content: `📬 New book request from ${interaction.user} pending approval:`,
          embeds: [embed],
          components: [approveRow],
        });
      }
    } else {
      // Auto-approve or admin requesting
      delete pendingRequests[searchKey];
      savePending();

      try {
        const added = await addBook(book);
        log("INFO", "Book added and search triggered", { title: book.title, id: added.id });

        const embed = bookEmbed(book, "approved", interaction.user.tag);
        await interaction.editReply({
          content: `✅ **${book.title}** has been added to Bookshelf and a search has been triggered!`,
          embeds: [embed],
          components: [],
        });
      } catch (e) {
        log("ERROR", "Failed to add book", { error: e.message, title: book.title });
        await interaction.editReply({
          content: `❌ Failed to add **${book.title}**: ${e.message}`,
          components: [],
        });
      }
    }
  }

  // ── Approve/Deny buttons ──
  if (interaction.isButton()) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: "❌ Only admins can approve or deny requests.", ephemeral: true });
    }

    const [action, ...idParts] = interaction.customId.split("_");
    const requestId = idParts.join("_");
    const request = pendingRequests[requestId];

    if (!request) {
      return interaction.reply({ content: "❌ Request not found or already handled.", ephemeral: true });
    }

    await interaction.deferUpdate();

    if (action === "approve") {
      try {
        const added = await addBook(request.book);
        log("INFO", "Request approved", { requestId, title: request.book.title, approvedBy: interaction.user.tag });

        request.status = "approved";
        request.approvedBy = interaction.user.tag;
        delete pendingRequests[requestId];
        savePending();

        const embed = bookEmbed(request.book, "approved", request.requester);
        await interaction.editReply({
          content: `✅ **${request.book.title}** approved by ${interaction.user.tag} and added to Bookshelf!`,
          embeds: [embed],
          components: [],
        });

        // DM the requester
        try {
          const requesterUser = await client.users.fetch(request.requesterId);
          await requesterUser.send(`✅ Your request for **${request.book.title}** has been approved and is now downloading!`);
        } catch (e) {
          log("WARN", "Could not DM requester", { error: e.message });
        }
      } catch (e) {
        log("ERROR", "Approve failed", { error: e.message });
        await interaction.editReply({ content: `❌ Failed to add book: ${e.message}`, components: [] });
      }
    }

    if (action === "deny") {
      log("INFO", "Request denied", { requestId, title: request.book.title, deniedBy: interaction.user.tag });
      delete pendingRequests[requestId];
      savePending();

      const embed = bookEmbed(request.book, "denied", request.requester);
      await interaction.editReply({
        content: `❌ **${request.book.title}** denied by ${interaction.user.tag}.`,
        embeds: [embed],
        components: [],
      });

      // DM the requester
      try {
        const requesterUser = await client.users.fetch(request.requesterId);
        await requesterUser.send(`❌ Your request for **${request.book.title}** was denied.`);
      } catch (e) {
        log("WARN", "Could not DM requester", { error: e.message });
      }
    }
  }

  // ── /status ──
  if (interaction.isChatInputCommand() && interaction.commandName === "status") {
    await interaction.deferReply();
    log("INFO", "Status command", { user: interaction.user.tag });

    try {
      const queue = await getQueue();
      const items = queue.records || queue || [];

      if (!items.length) {
        return interaction.editReply({ content: "📭 The download queue is empty." });
      }

      const embed = new EmbedBuilder()
        .setTitle("📥 Download Queue")
        .setColor(0x5865f2)
        .setTimestamp()
        .setFooter({ text: "Librarian" });

      items.slice(0, 10).forEach((item) => {
        const status = item.status || "unknown";
        const size = item.size ? `${(item.size / 1024 / 1024).toFixed(0)}MB` : "";
        embed.addFields({
          name: item.title || "Unknown",
          value: `Status: ${status}${size ? ` • ${size}` : ""}`,
          inline: false,
        });
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (e) {
      log("ERROR", "Status command failed", { error: e.message });
      await interaction.editReply({ content: `❌ Error fetching queue: ${e.message}` });
    }
  }

  // ── /library ──
  if (interaction.isChatInputCommand() && interaction.commandName === "library") {
    const query = interaction.options.getString("query").toLowerCase();
    await interaction.deferReply();
    log("INFO", "Library command", { user: interaction.user.tag, query });

    try {
      const library = await getLibrary();
      const matches = library.filter(
        (b) =>
          b.title?.toLowerCase().includes(query) ||
          b.author?.authorName?.toLowerCase().includes(query)
      ).slice(0, 5);

      if (!matches.length) {
        return interaction.editReply({ content: `❌ No books matching **${query}** in the library.` });
      }

      const embeds = matches.map((b) => bookEmbed(b));
      await interaction.editReply({
        content: `Found **${matches.length}** match(es) in the library:`,
        embeds,
      });
    } catch (e) {
      log("ERROR", "Library command failed", { error: e.message });
      await interaction.editReply({ content: `❌ Error searching library: ${e.message}` });
    }
  }

  // ── /pending ──
  if (interaction.isChatInputCommand() && interaction.commandName === "pending") {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    const pending = Object.entries(pendingRequests)
      .filter(([k, v]) => k.startsWith("req_") && v.status === "pending");

    if (!pending.length) {
      return interaction.reply({ content: "📭 No pending requests.", ephemeral: true });
    }

    const embeds = pending.slice(0, 5).map(([id, req]) => {
      const embed = bookEmbed(req.book, "pending", req.requester);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_${id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`deny_${id}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
      );
      return { embed, row };
    });

    await interaction.reply({
      content: `📋 **${pending.length}** pending request(s):`,
      embeds: embeds.map((e) => e.embed),
      components: embeds.map((e) => e.row),
      ephemeral: true,
    });
  }

  // ── /logs ──
  if (interaction.isChatInputCommand() && interaction.commandName === "logs") {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    try {
      const logContent = fs.readFileSync(config.LOG_FILE, "utf8");
      const lines = logContent.trim().split("\n").slice(-20); // last 20 entries
      const parsed = lines.map((l) => {
        try {
          const e = JSON.parse(l);
          return `\`${e.timestamp.slice(11, 19)}\` **[${e.level}]** ${e.message}`;
        } catch {
          return l;
        }
      });

      await interaction.reply({
        content: `📋 **Recent logs:**\n${parsed.join("\n")}`,
        ephemeral: true,
      });
    } catch (e) {
      await interaction.reply({ content: `❌ Could not read logs: ${e.message}`, ephemeral: true });
    }
  }
});

// ─── Ready ─────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  log("INFO", `Bot online as ${client.user.tag}`);
  await registerCommands();
});

client.login(config.DISCORD_TOKEN).catch((e) => {
  log("ERROR", "Login failed", { error: e.message });
  process.exit(1);
});

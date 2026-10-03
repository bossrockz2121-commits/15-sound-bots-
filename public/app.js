const loginScreen = document.querySelector("#login-screen");
const appShell = document.querySelector("#app-shell");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const botList = document.querySelector("#bot-list");
const audioSelect = document.querySelector("#audio-select");
const uploadNote = document.querySelector("#upload-note");
const selectedBots = new Set();
let botState = [];
let audioState = [];
let lastBotRenderSignature = "";

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...options.headers
    }
  });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (response.status === 401) {
    loginScreen.classList.remove("hidden");
    appShell.classList.add("hidden");
  }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function toast(message, isError = false) {
  const region = document.querySelector("#toast-region");
  const item = document.createElement("div");
  item.className = `toast${isError ? " error" : ""}`;
  item.textContent = message;
  region.append(item);
  setTimeout(() => item.remove(), 4200);
}

function setSignedIn(isSignedIn) {
  loginScreen.classList.toggle("hidden", isSignedIn);
  appShell.classList.toggle("hidden", !isSignedIn);
}

function statusLabel(status) {
  return ({
    ready: "READY",
    connected: "IN VOICE",
    connecting: "CONNECTING",
    disconnected: "DISCONNECTED",
    error: "ERROR",
    token_missing: "NO TOKEN"
  })[status] || String(status || "OFFLINE").toUpperCase();
}

function renderBotCards() {
  const previouslyFocused = document.activeElement?.dataset?.botId;
  botList.replaceChildren();
  botState.forEach((bot, index) => {
    const card = document.createElement("article");
    card.className = `bot-card${selectedBots.has(bot.id) ? " selected" : ""}`;
    const topline = document.createElement("div");
    topline.className = "bot-topline";

    const checkbox = document.createElement("input");
    checkbox.className = "bot-check";
    checkbox.type = "checkbox";
    checkbox.checked = selectedBots.has(bot.id);
    checkbox.setAttribute("aria-label", `Select ${bot.name}`);
    checkbox.dataset.botId = bot.id;

    const avatar = document.createElement("span");
    avatar.className = "bot-avatar";
    avatar.textContent = String(index + 1).padStart(2, "0");

    const identity = document.createElement("span");
    identity.className = "bot-identity";
    const name = document.createElement("strong");
    name.textContent = bot.name;
    const botName = document.createElement("small");
    botName.textContent = bot.botName || bot.id.toUpperCase();
    identity.append(name, botName);

    const state = document.createElement("span");
    state.className = "bot-state";
    state.dataset.status = bot.status;
    const dot = document.createElement("i");
    const stateName = document.createElement("span");
    stateName.textContent = statusLabel(bot.status);
    state.append(dot, stateName);
    topline.append(checkbox, avatar, identity, state);

    const controls = document.createElement("div");
    controls.className = "bot-controls";
    const channelControls = document.createElement("div");
    channelControls.className = "channel-controls";

    const guildSelect = document.createElement("select");
    guildSelect.setAttribute("aria-label", `Server for ${bot.name}`);
    guildSelect.dataset.guildSelect = bot.id;
    const guildPlaceholder = document.createElement("option");
    guildPlaceholder.value = "";
    guildPlaceholder.textContent = bot.guildId ? "Server selected" : "Load servers…";
    guildSelect.append(guildPlaceholder);
    guildSelect.value = "";
    guildSelect.disabled = bot.status !== "ready" && bot.status !== "connected";
    guildSelect.title = bot.guildId || "Load servers to choose a server";

    const channelSelect = document.createElement("select");
    channelSelect.setAttribute("aria-label", `Voice channel for ${bot.name}`);
    channelSelect.dataset.channelSelect = bot.id;
    const channelPlaceholder = document.createElement("option");
    channelPlaceholder.value = "";
    channelPlaceholder.textContent = bot.channelId ? `Channel saved · ${bot.channelId.slice(-5)}` : "Choose a channel…";
    channelSelect.append(channelPlaceholder);
    channelSelect.value = "";
    channelSelect.disabled = true;
    channelSelect.title = bot.channelId || "";
    channelControls.append(guildSelect, channelSelect);

    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.className = "load-channels";
    loadButton.dataset.loadChannels = bot.id;
    loadButton.textContent = bot.guildId
      ? `↻  Change server or channel${bot.channelId ? ` · saved ${bot.channelId.slice(-5)}` : ""}`
      : "＋  Load servers & voice channels";
    loadButton.disabled = guildSelect.disabled;
    controls.append(channelControls, loadButton);

    if (bot.error) {
      const error = document.createElement("p");
      error.className = "bot-error";
      error.textContent = bot.error;
      controls.append(error);
    }
    card.append(topline, controls);
    botList.append(card);
  });

  updateSelectionSummary();
  if (previouslyFocused) {
    botList.querySelector(`[data-bot-id="${CSS.escape(previouslyFocused)}"]`)?.focus();
  }
}

function renderAudio() {
  const selected = audioSelect.value;
  audioSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = audioState.length ? "Choose an audio file…" : "Upload a sound to get started";
  audioSelect.append(placeholder);
  audioState.forEach((audio) => {
    const option = document.createElement("option");
    option.value = audio.id;
    option.textContent = audio.name;
    audioSelect.append(option);
  });
  audioSelect.value = audioState.some((audio) => audio.id === selected) ? selected : (audioState[0]?.id || "");
}

function updateSelectionSummary() {
  const count = selectedBots.size;
  document.querySelector("#selected-count").textContent = count;
  document.querySelector("#dock-count").textContent = count;
  document.querySelector("#metric-selected").textContent = count;
  document.querySelector("#select-all").checked = botState.length > 0 && count === botState.length;
  document.querySelector("#select-all").indeterminate = count > 0 && count < botState.length;
}

function updateMetrics() {
  const connected = botState.filter((bot) => bot.status === "connected").length;
  const playing = botState.filter((bot) => bot.playing).length;
  const online = botState.filter((bot) => ["ready", "connected"].includes(bot.status)).length;
  document.querySelector("#online-count").textContent = online;
  document.querySelector("#metric-connected").textContent = connected;
  document.querySelector("#metric-playing").textContent = playing;
  const fleetStatus = document.querySelector("#fleet-status");
  fleetStatus.textContent = botState.some((bot) => bot.status === "error") ? "CHECK FLEET" : (connected ? "SOUND ON" : "STANDING BY");
  document.querySelector("#gateway-state").textContent = online ? `${online} bot${online === 1 ? "" : "s"} online` : "Waiting for bot tokens";
}

async function refreshStatus() {
  const data = await api("/api/status");
  botState = data.bots;
  audioState = data.audio;
  for (const id of [...selectedBots]) {
    if (!botState.some((bot) => bot.id === id)) selectedBots.delete(id);
  }
  const signature = JSON.stringify(botState);
  if (signature !== lastBotRenderSignature) {
    renderBotCards();
    lastBotRenderSignature = signature;
  } else {
    updateSelectionSummary();
  }
  renderAudio();
  updateMetrics();
}

async function loadGuilds(botId) {
  const guildSelect = botList.querySelector(`[data-guild-select="${CSS.escape(botId)}"]`);
  const channelSelect = botList.querySelector(`[data-channel-select="${CSS.escape(botId)}"]`);
  const button = botList.querySelector(`[data-load-channels="${CSS.escape(botId)}"]`);
  button.disabled = true;
  button.textContent = "Loading servers…";
  try {
    const data = await api(`/api/bots/${encodeURIComponent(botId)}/guilds`);
    guildSelect.replaceChildren(new Option("Choose a server…", ""));
    data.guilds.forEach((guild) => guildSelect.append(new Option(guild.name, guild.id)));
    const current = botState.find((bot) => bot.id === botId);
    guildSelect.value = data.guilds.some((guild) => guild.id === current?.guildId) ? current.guildId : "";
    channelSelect.replaceChildren(new Option("Choose a channel…", ""));
    channelSelect.disabled = !guildSelect.value;
    button.textContent = "↻  Change server or channel";
    if (guildSelect.value) await loadChannels(botId, guildSelect.value);
  } catch (error) {
    button.textContent = "＋  Load servers & voice channels";
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function loadChannels(botId, guildId) {
  const channelSelect = botList.querySelector(`[data-channel-select="${CSS.escape(botId)}"]`);
  channelSelect.disabled = true;
  channelSelect.replaceChildren(new Option("Loading channels…", ""));
  try {
    const data = await api(`/api/bots/${encodeURIComponent(botId)}/channels?guildId=${encodeURIComponent(guildId)}`);
    channelSelect.replaceChildren(new Option("Choose a voice channel…", ""));
    data.channels.forEach((channel) => {
      const prefix = channel.parentName ? `${channel.parentName} / ` : "";
      channelSelect.append(new Option(`${prefix}${channel.name}`, channel.id));
    });
    const current = botState.find((bot) => bot.id === botId);
    channelSelect.value = data.channels.some((channel) => channel.id === current?.channelId) ? current.channelId : "";
    channelSelect.disabled = false;
    if (!data.channels.length) toast("No voice channels found for this bot in that server.", true);
  } catch (error) {
    channelSelect.replaceChildren(new Option("Could not load channels", ""));
    toast(error.message, true);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const password = new FormData(loginForm).get("password");
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
    loginForm.reset();
    setSignedIn(true);
    await refreshStatus();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch (error) {
    toast(error.message, true);
  } finally {
    selectedBots.clear();
    setSignedIn(false);
  }
});

document.querySelector("#refresh-button").addEventListener("click", async () => {
  try {
    await refreshStatus();
    toast("Bot status refreshed.");
  } catch (error) {
    toast(error.message, true);
  }
});

document.querySelector("#select-all").addEventListener("change", (event) => {
  selectedBots.clear();
  if (event.target.checked) botState.forEach((bot) => selectedBots.add(bot.id));
  renderBotCards();
});

botList.addEventListener("change", async (event) => {
  const botId = event.target.dataset.botId;
  if (botId) {
    if (event.target.checked) selectedBots.add(botId);
    else selectedBots.delete(botId);
    event.target.closest(".bot-card").classList.toggle("selected", event.target.checked);
    updateSelectionSummary();
    return;
  }

  const guildBotId = event.target.dataset.guildSelect;
  if (guildBotId) {
    if (event.target.value) {
      try {
        await api(`/api/bots/${encodeURIComponent(guildBotId)}/channel`, {
          method: "PUT",
          body: JSON.stringify({ guildId: event.target.value, channelId: "" })
        });
        const current = botState.find((bot) => bot.id === guildBotId);
        if (current) {
          current.guildId = event.target.value;
          current.channelId = "";
        }
        await loadChannels(guildBotId, event.target.value);
      } catch (error) {
        toast(error.message, true);
      }
    }
    return;
  }

  const channelBotId = event.target.dataset.channelSelect;
  if (channelBotId && event.target.value) {
    const card = event.target.closest(".bot-card");
    const guildId = card.querySelector(`[data-guild-select="${CSS.escape(channelBotId)}"]`).value;
    try {
      await api(`/api/bots/${encodeURIComponent(channelBotId)}/channel`, {
        method: "PUT",
        body: JSON.stringify({ guildId, channelId: event.target.value })
      });
      toast("Voice channel saved for this bot.");
      await refreshStatus();
    } catch (error) {
      toast(error.message, true);
    }
  }
});

botList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-load-channels]");
  if (button) await loadGuilds(button.dataset.loadChannels);
});

document.querySelector("#audio-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  uploadNote.classList.remove("error");
  uploadNote.textContent = `Uploading ${file.name}…`;
  const form = new FormData();
  form.append("audio", file);
  try {
    const data = await api("/api/audio", { method: "POST", body: form });
    await refreshStatus();
    audioSelect.value = data.audio.id;
    uploadNote.textContent = `Ready to play: ${data.audio.name}`;
    toast("Audio uploaded and ready.");
  } catch (error) {
    uploadNote.classList.add("error");
    uploadNote.textContent = error.message;
    toast(error.message, true);
  } finally {
    event.target.value = "";
  }
});

document.querySelector(".dock-actions").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (["start", "stop"].includes(action) && selectedBots.size === 0) {
    toast("Select at least one bot from your fleet first.", true);
    return;
  }
  if (["start", "start-all"].includes(action) && !audioSelect.value) {
    toast("Upload and select an audio file first.", true);
    return;
  }

  const previousLabel = button.innerHTML;
  button.disabled = true;
  if (["start", "start-all"].includes(action)) button.querySelector("span").textContent = "Starting…";
  if (["stop", "stop-all"].includes(action)) button.querySelector("span").textContent = "Stopping…";
  try {
    const data = await api("/api/control", {
      method: "POST",
      body: JSON.stringify({
        action,
        botIds: ["start", "stop"].includes(action) ? [...selectedBots] : undefined,
        audioId: ["start", "start-all"].includes(action) ? audioSelect.value : undefined
      })
    });
    const failures = data.results.filter((result) => !result.ok);
    const successes = data.results.length - failures.length;
    if (!data.results.length) toast("No bots are currently connected to voice.");
    else if (failures.length) {
      toast(`${successes} of ${data.results.length} bots completed; ${failures.length} failed. ${failures[0].error}`, true);
    } else {
      const actionLabel = button.textContent.trim().replace(/^[▶■◖◗⊘◎]\s*/, "");
      toast(`${actionLabel} applied to ${successes} bot${successes === 1 ? "" : "s"}.`);
    }
    await refreshStatus();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = previousLabel;
  }
});

async function initialize() {
  try {
    await refreshStatus();
    setSignedIn(true);
  } catch (error) {
    if (error.message !== "Log in to control the bots.") {
      loginError.textContent = error.message;
    }
  }
}

initialize();
setInterval(() => {
  if (!appShell.classList.contains("hidden")) {
    refreshStatus().catch((error) => {
      if (error.message !== "Log in to control the bots.") toast(error.message, true);
    });
  }
}, 8000);

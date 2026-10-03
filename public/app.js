const loginScreen = document.querySelector("#login-screen");
const appShell = document.querySelector("#app-shell");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const botList = document.querySelector("#bot-list");
const audioSelect = document.querySelector("#audio-select");
const uploadNote = document.querySelector("#upload-note");
let botState = [];
let audioState = [];
let lastBotRenderSignature = "";
let appliedFleetChannelId = "";
let statusPollFailureShown = false;

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }),
        ...options.headers
      }
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Cannot reach the dashboard server. It may be restarting or unavailable; check the Render service status and logs.");
    }
    throw error;
  }
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

function isOnline(bot) {
  return Boolean(bot.online);
}

function renderBotCards() {
  botList.replaceChildren();
  botState.forEach((bot, index) => {
    const card = document.createElement("article");
    card.className = "bot-card";
    card.dataset.online = String(isOnline(bot));

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
    state.className = `bot-state ${isOnline(bot) ? "online" : "offline"}`;
    state.dataset.status = bot.status;
    state.title = bot.error || (isOnline(bot) ? "Discord bot is online" : "Discord bot is offline");
    const dot = document.createElement("i");
    const stateName = document.createElement("span");
    stateName.textContent = isOnline(bot) ? "ONLINE" : "OFFLINE";
    state.append(dot, stateName);

    const controls = document.createElement("div");
    controls.className = "bot-state-details";
    const connectionState = document.createElement("span");
    connectionState.className = "bot-state-detail";
    const voiceState = bot.voiceState ? ` · ${bot.voiceState}` : "";
    connectionState.textContent = bot.playing
      ? `Playing audio${voiceState}`
      : bot.status === "connected"
        ? `Voice media ready${voiceState}`
        : bot.voiceState === "signalling" || bot.voiceState === "connecting"
          ? `Voice join pending${voiceState}`
          : `Not in voice${voiceState}`;
    const audioStateText = document.createElement("span");
    audioStateText.className = "bot-state-detail";
    audioStateText.textContent = bot.audioName ? `♪ ${bot.audioName}` : (bot.channelId ? `Channel · ${bot.channelId}` : "No voice channel ID");
    controls.append(connectionState, audioStateText);
    if (bot.voiceState === "signalling" && bot.voiceHandshake) {
      const handshake = bot.voiceHandshake;
      const waitingFor = [];
      if (!handshake.voiceStateUpdateReceived) waitingFor.push("bot voice-state update");
      if (!handshake.voiceStateSessionReceived) waitingFor.push("bot voice session ID");
      if (!handshake.voiceServerUpdateReceived) waitingFor.push("voice-server update");
      if (!handshake.voiceServerEndpointReceived) waitingFor.push("voice endpoint");
      const handshakeState = document.createElement("span");
      handshakeState.className = "bot-state-detail";
      const channelMismatch = handshake.voiceStateChannelId &&
        bot.channelId &&
        handshake.voiceStateChannelId !== bot.channelId;
      handshakeState.textContent = waitingFor.length
        ? `Discord handshake waiting for: ${waitingFor.join(", ")}`
        : channelMismatch
          ? `Discord voice-state channel ${handshake.voiceStateChannelId} does not match selected channel ${bot.channelId}`
          : `Discord handshake updates received${handshake.voiceServerEndpointHost ? ` · ${handshake.voiceServerEndpointHost}` : ""}${bot.voiceNetworkStage ? ` · ${bot.voiceNetworkStage}` : ""}`;
      controls.append(handshakeState);
    }

    if (bot.error) {
      const error = document.createElement("p");
      error.className = "bot-error";
      error.textContent = bot.error;
      controls.append(error);
    }
    if (bot.gatewayError && bot.status !== "error") {
      const gatewayError = document.createElement("p");
      gatewayError.className = "bot-error";
      gatewayError.textContent = bot.gatewayError;
      controls.append(gatewayError);
    }

    const topLine = document.createElement("div");
    topLine.className = "bot-topline";
    topLine.append(avatar, identity, state);
    card.append(topLine, controls);
    botList.append(card);
  });
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

function updateMetrics() {
  const connected = botState.filter((bot) => bot.status === "connected").length;
  const playing = botState.filter((bot) => bot.playing).length;
  const online = botState.filter(isOnline).length;
  document.querySelector("#online-count").textContent = online;
  document.querySelector("#metric-connected").textContent = connected;
  document.querySelector("#metric-playing").textContent = playing;
  const tokenBots = botState.filter((bot) => bot.hasToken).length;
  document.querySelector("#configured-count").textContent = tokenBots;
  document.querySelector("#fleet-online-count").textContent = online;
  const fleetStatus = document.querySelector("#fleet-status");
  fleetStatus.textContent = botState.some((bot) => bot.status === "error") ? "CHECK FLEET" : (connected ? "SOUND ON" : "STANDING BY");
  document.querySelector("#gateway-state").textContent = online ? `${online} bot${online === 1 ? "" : "s"} online` : "Waiting for bot tokens";
}

async function refreshStatus() {
  const data = await api("/api/status");
  botState = data.bots;
  audioState = data.audio;
  appliedFleetChannelId = data.fleetChannelId || "";
  const channelInput = document.querySelector("#fleet-channel-id");
  if (document.activeElement !== channelInput) channelInput.value = appliedFleetChannelId;
  const signature = JSON.stringify(botState);
  if (signature !== lastBotRenderSignature) {
    renderBotCards();
    lastBotRenderSignature = signature;
  }
  renderAudio();
  updateMetrics();
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

document.querySelector("#fleet-channel-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const channelId = document.querySelector("#fleet-channel-id").value.trim();
  if (!/^\d{17,20}$/.test(channelId)) {
    toast("Enter a valid Discord voice channel ID (17–20 digits).", true);
    return;
  }
  try {
    const result = await api("/api/fleet/channel", {
      method: "PUT",
      body: JSON.stringify({ channelId })
    });
    appliedFleetChannelId = result.channelId;
    await refreshStatus();
    const failures = result.results.filter((bot) => !bot.ok);
    if (failures.length) {
      const detail = failures
        .slice(0, 3)
        .map((bot) => {
          const prefix = `${bot.name}: `;
          const error = bot.error.startsWith(prefix) ? bot.error.slice(prefix.length) : bot.error;
          return `${bot.name}: ${error}`;
        })
        .join(" | ");
      const others = failures.length > 3 ? ` | and ${failures.length - 3} more; see bot cards.` : "";
      toast(`${result.joined} of ${result.total} voice connections became ready. ${detail}${others}`, true);
    } else if (result.joined === 0) {
      toast("Channel ID saved, but no bots are online yet. Check the bot tokens in Render.", true);
    } else {
      toast(`All ${result.joined} voice connections are ready.`);
    }
  } catch (error) {
    toast(error.message, true);
  }
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

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "join-all") {
    const channelId = document.querySelector("#fleet-channel-id").value.trim();
    if (!/^\d{17,20}$/.test(channelId)) {
      toast("Enter a valid Discord voice channel ID before joining.", true);
      return;
    }

    button.disabled = true;
    const previousLabel = button.innerHTML;
    button.querySelector("span").textContent = "Joining…";
    try {
      const result = await api("/api/fleet/channel", {
        method: "PUT",
        body: JSON.stringify({ channelId })
      });
      appliedFleetChannelId = result.channelId;
      await refreshStatus();
      const failures = result.results.filter((bot) => !bot.ok);
      if (failures.length) {
        const detail = failures.slice(0, 3).map((bot) => `${bot.name}: ${bot.error}`).join(" | ");
        const others = failures.length > 3 ? ` | and ${failures.length - 3} more; see bot cards.` : "";
        toast(`${result.joined} of ${result.total} bots joined. ${detail}${others}`, true);
      } else {
        toast(`All ${result.joined} bots joined the voice channel.`);
      }
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.innerHTML = previousLabel;
      button.disabled = false;
    }
    return;
  }

  if (action === "start-all" && !audioSelect.value) {
    toast("Upload and select an audio file first.", true);
    return;
  }
  if (action === "start-all") {
    const enteredChannelId = document.querySelector("#fleet-channel-id").value.trim();
    if (!enteredChannelId || enteredChannelId !== appliedFleetChannelId) {
      toast("Enter the voice channel ID and click Join VC first.", true);
      return;
    }
  }

  const previousLabel = button.innerHTML;
  button.disabled = true;
  if (action === "start-all") button.querySelector("span").textContent = "Preparing…";
  if (action === "stop-all") button.querySelector("span").textContent = "Stopping…";
  if (action === "disconnect-all") button.querySelector("span").textContent = "Leaving…";
  try {
    const data = await api("/api/control", {
      method: "POST",
      body: JSON.stringify({
        action,
        audioId: action === "start-all" ? audioSelect.value : undefined
      })
    });
    const failures = data.results.filter((result) => !result.ok);
    const successes = data.results.length - failures.length;
    if (!data.results.length) toast(action === "stop-all" ? "No bots are playing audio." : "No bots are connected or joining voice.");
    else if (failures.length) {
      toast(`${successes} of ${data.results.length} bots completed; ${failures.length} failed. ${failures[0].error}`, true);
    } else {
      toast(action === "start-all"
        ? `Audio playback started on ${successes} bot${successes === 1 ? "" : "s"}.`
        : `${button.querySelector("span").textContent} applied to ${successes} bot${successes === 1 ? "" : "s"}.`);
    }
    await refreshStatus();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.innerHTML = previousLabel;
    button.disabled = false;
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
    refreshStatus().then(() => {
      statusPollFailureShown = false;
    }).catch((error) => {
      if (error.message !== "Log in to control the bots." && !statusPollFailureShown) {
        toast(error.message, true);
        statusPollFailureShown = true;
      }
    });
  }
}, 8000);

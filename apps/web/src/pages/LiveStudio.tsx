import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, getToken } from "../api";
import { Badge, Button, Card, Field, Input, Modal, PageHead, Select, Spinner, useFetch } from "../components/ui";
import type { Djslot, StationSettings, Track, User } from "@radiohost/shared";
import { zonedParts } from "@radiohost/shared";

interface DeckState {
  track: Track | null;
  buffer: AudioBuffer | null;
  offset: number; // seconds played within track
  playing: boolean;
  volume: number;
  pfl: boolean;
  /** AudioContext.currentTime when playback started, and the offset it started
   *  from — lets us derive the true position instead of guessing. */
  startedAt: number;
  startOffset: number;
}

const EMPTY_DECK: DeckState = { track: null, buffer: null, offset: 0, playing: false, volume: 0.88, pfl: false, startedAt: 0, startOffset: 0 };
const CARTS_KEY = "rhs_live_carts";

// AudioWorklet capture processor: runs on the dedicated audio thread (unlike the
// deprecated ScriptProcessorNode, which glitches/clicks when the main thread is
// busy). Accumulates ~2048 stereo frames, then posts an interleaved f32 buffer.
const LIVE_CAPTURE_WORKLET = `
class LiveCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048 * 2);
    this._n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length >= 2) {
      const l = input[0];
      const r = input[1];
      for (let i = 0; i < l.length; i++) {
        this._buf[this._n * 2] = l[i];
        this._buf[this._n * 2 + 1] = r[i];
        this._n++;
        if (this._n >= 2048) {
          const out = this._buf.slice();
          this.port.postMessage(out.buffer, [out.buffer]);
          this._n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('live-capture', LiveCaptureProcessor);
`;

export function LiveStudio() {
  const ctxRef = useRef<AudioContext | null>(null);
  const workletLoaded = useRef(false);
  const [ready, setReady] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [live, setLive] = useState(false);
  const [liveDj, setLiveDj] = useState<string | null>(null);
  const [decks, setDecks] = useState<[DeckState, DeckState]>([EMPTY_DECK, EMPTY_DECK]);
  const [carts, setCarts] = useState<Array<{ track: Track | null; buffer: AudioBuffer | null; playing: boolean }>>(
    Array.from({ length: 8 }, () => ({ track: null, buffer: null, playing: false })),
  );
  const [cartVol, setCartVol] = useState(0.85);
  const [micVol, setMicVol] = useState(0.85);
  const [masterVol, setMasterVol] = useState(0.9);
  const [pfl, setPfl] = useState<Set<string>>(new Set());
  const [deckPicker, setDeckPicker] = useState<0 | 1 | null>(null);
  const [cartPicker, setCartPicker] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  // Per-cart playback clock (AudioContext time at start + buffer length) for the cue countdown.
  const cartClock = useRef<Array<{ start: number; duration: number } | null>>(Array.from({ length: 8 }, () => null));

  // Audio graph refs
  const nodes = useRef<Record<string, AudioNode>>({});
  const duckRef = useRef<Array<GainNode | null>>([null, null, null, null]);
  // Per-deck node chain (gain -> duck -> pfl) so we can disconnect it cleanly when
  // a deck restarts — otherwise nodes accumulate on the master over a long show.
  const deckChain = useRef<Array<AudioNode[]>>([[], []]);
  const [deckErrors, setDeckErrors] = useState<[string | null, string | null]>([null, null]);

  /* ---------------- Audio graph setup ---------------- */
  const ensureCtx = async () => {
    if (ctxRef.current) return ctxRef.current;
    const ctx = new AudioContext({ sampleRate: 48000 });
    ctxRef.current = ctx;
    const master = ctx.createGain();
    master.gain.value = masterVol;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp);
    comp.connect(ctx.destination);
    const monitor = ctx.createGain();
    monitor.gain.value = 0.9;
    monitor.connect(ctx.destination);
    nodes.current.master = master;
    nodes.current.monitor = monitor;
    nodes.current.comp = comp;

    // Capture bus (post-master) -> gentle bus compressor -> safety limiter ->
    // broadcast. A mild bus compressor smooths the whole mix (music + mic)
    // before the hard limiter, so the limiter isn't slammed and the sound stays
    // clear rather than "pumping" on loud peaks. Local monitoring keeps its own
    // compressor above (separate path).
    const capture = ctx.createGain();
    const busComp = ctx.createDynamicsCompressor();
    busComp.threshold.value = -14; // dB — start gently reducing above -14 dB
    busComp.knee.value = 12;
    busComp.ratio.value = 2.2;
    busComp.attack.value = 0.02;
    busComp.release.value = 0.22;
    const broadcastLimiter = ctx.createDynamicsCompressor();
    broadcastLimiter.threshold.value = -1; // dBFS — start reducing above -1 dB
    broadcastLimiter.knee.value = 0;
    broadcastLimiter.ratio.value = 20; // effectively a limiter
    broadcastLimiter.attack.value = 0.003;
    broadcastLimiter.release.value = 0.18;
    master.connect(busComp);
    busComp.connect(broadcastLimiter);
    broadcastLimiter.connect(capture);
    nodes.current.capture = capture;
    nodes.current.busComp = busComp;
    nodes.current.broadcastLimiter = broadcastLimiter;
    // VU meter: tap the on-air signal (post-limiter) so the Master meter shows
    // exactly what is being sent out.
    const meter = ctx.createAnalyser();
    meter.fftSize = 1024;
    meter.smoothingTimeConstant = 0;
    capture.connect(meter);
    nodes.current.masterMeter = meter;
    return ctx;
  };

  useEffect(() => {
    void ensureCtx().then(() => setReady(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Master volume + PFL routing
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    (nodes.current.master as GainNode).gain.setTargetAtTime(masterVol, ctx.currentTime, 0.05);
    // PFL: route monitor bus to output; otherwise master.
    const anyPfl = pfl.size > 0;
    const mon = nodes.current.monitor as GainNode;
    const comp = nodes.current.comp as DynamicsCompressorNode;
    if (anyPfl) {
      mon.disconnect();
      mon.connect(ctx.destination);
      comp.disconnect();
    } else {
      comp.connect(ctx.destination);
      mon.disconnect();
    }
  }, [masterVol, pfl]);

  /* ---------------- Live capture + WS ---------------- */
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !live) return;
    let node: AudioWorkletNode | null = null;
    let sp: ScriptProcessorNode | null = null;
    let silent: GainNode | null = null;
    let cancelled = false;
    const send = (buf: ArrayBuffer) => {
      const socket = wsRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(buf);
    };
    const start = async () => {
      const cap = nodes.current.capture as GainNode | undefined;
      if (!cap) return;
      silent = ctx.createGain();
      silent.gain.value = 0;
      silent.connect(ctx.destination);
      if (ctx.audioWorklet) {
        try {
          if (!workletLoaded.current) {
            const url = URL.createObjectURL(new Blob([LIVE_CAPTURE_WORKLET], { type: "application/javascript" }));
            await ctx.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            workletLoaded.current = true;
          }
          node = new AudioWorkletNode(ctx, "live-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          node.port.onmessage = (e) => send(e.data as ArrayBuffer);
          cap.connect(node);
          node.connect(silent);
          if (cancelled) node.disconnect();
          return;
        } catch {
          /* fall back to ScriptProcessor below */
        }
      }
      sp = ctx.createScriptProcessor(4096, 2, 2);
      sp.onaudioprocess = (e) => {
        const l = e.inputBuffer.getChannelData(0);
        const r = e.inputBuffer.getChannelData(1);
        const inter = new Float32Array(l.length * 2);
        for (let i = 0; i < l.length; i++) {
          inter[i * 2] = l[i]!;
          inter[i * 2 + 1] = r[i]!;
        }
        send(inter.buffer);
      };
      cap.connect(sp);
      sp.connect(silent);
    };
    void start();
    return () => {
      cancelled = true;
      node?.disconnect();
      sp?.disconnect();
      silent?.disconnect();
    };
  }, [live]);

  const wsRef = useRef<WebSocket | null>(null);
  const [goLiveOpen, setGoLiveOpen] = useState(false);
  const [goLiveShow, setGoLiveShow] = useState("");
  const { data: me } = useFetch(() => api<{ user: User }>("/auth/me"));
  const { data: assignedSlots } = useFetch(() => api<{ slots: Djslot[] }>("/dj-slots"));
  const { data: stationSettings } = useFetch(() => api<{ settings: StationSettings }>("/settings"));

  const stopLive = () => {
    wsRef.current?.close();
    setLive(false);
    setLiveDj(null);
  };

  const startLive = (showName: string) => {
    if (me?.user.role === "dj" && !currentDjSlot(assignedSlots?.slots ?? [], stationSettings?.settings.timezone)) {
      alert("You can only go live during an admin-assigned show slot.");
      return;
    }
    setGoLiveOpen(false);
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ token });
    if (showName.trim()) params.set("show", showName.trim().slice(0, 80));
    const socket = new WebSocket(`${proto}://${location.host}/live-ws?${params.toString()}`);
    wsRef.current = socket;
    socket.onopen = () => setLive(true);
    socket.onclose = () => {
      setLive(false);
      setLiveDj(null);
    };
  };
  void liveDj;

  // Ducking: open mic ducks the music channels.
  useEffect(() => {
    if (!micOn) {
      for (const g of duckRef.current) g?.gain.setTargetAtTime(1, ctxRef.current?.currentTime ?? 0, 0.1);
      return;
    }
    for (const g of duckRef.current) g?.gain.setTargetAtTime(0.28, ctxRef.current?.currentTime ?? 0, 0.15);
  }, [micOn]);

  /* ---------------- Mic ---------------- */
  const toggleMic = async () => {
    const ctx = await ensureCtx();
    if (micOn) {
      nodes.current.mic?.disconnect();
      setMicOn(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
      const src = ctx.createMediaStreamSource(stream);
      // Mic processor chain: high-pass (kill rumble/plosives) -> compressor
      // (catch loud peaks so a loud or close-to-mic delivery stays clean rather
      // than clipping/slamming the broadcast limiter) -> makeup -> level.
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 90;
      hp.Q.value = 0.7;
      const mc = ctx.createDynamicsCompressor();
      mc.threshold.value = -22;
      mc.knee.value = 10;
      mc.ratio.value = 4;
      mc.attack.value = 0.008;
      mc.release.value = 0.18;
      const makeup = ctx.createGain();
      makeup.gain.value = 1.35;
      const g = ctx.createGain();
      g.gain.value = micVol;
      src.connect(hp);
      hp.connect(mc);
      mc.connect(makeup);
      makeup.connect(g);
      g.connect(nodes.current.master as GainNode);
      // Tap the processed mic (post compressor, pre master) so the Mic card's
      // meter shows only the voice contribution — lets you set gain so your
      // loudest delivery stays under the red.
      const mm = ctx.createAnalyser();
      mm.fftSize = 1024;
      mm.smoothingTimeConstant = 0;
      g.connect(mm);
      nodes.current.mic = src;
      nodes.current.micHp = hp;
      nodes.current.micComp = mc;
      nodes.current.micGain = g;
      nodes.current.micMeter = mm;
      setMicOn(true);
    } catch {
      alert("Microphone permission denied");
    }
  };
  useEffect(() => {
    const g = nodes.current.micGain as GainNode | undefined;
    if (g) g.gain.setTargetAtTime(micVol, ctxRef.current?.currentTime ?? 0, 0.05);
  }, [micVol]);

  // Global Space = mic toggle, no matter which studio control has focus. This
  // stops Space from firing whichever button/control happens to be focused
  // (e.g. a deck or cart button) and silently dropping the mic command.
  const toggleMicRef = useRef(toggleMic);
  toggleMicRef.current = toggleMic;
  useEffect(() => {
    const editable = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null;
      const tag = node?.tagName;
      return !!node && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (editable(e.target)) return;
      // Take over the keypress so the focused control doesn't also fire.
      e.preventDefault();
      e.stopPropagation();
      void toggleMicRef.current();
    };
    // Buttons trigger their click on Space KEYUP; suppress that too so a focused
    // mic/deck/cart button doesn't double-activate.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (editable(e.target)) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, []);

  // Stable accessor so the VU meter's animation loop can read the analyser node
  // without re-running its effect on every render.
  const getMasterMeter = useCallback(() => nodes.current.masterMeter as AnalyserNode | undefined, []);
  const getMicMeter = useCallback(() => nodes.current.micMeter as AnalyserNode | undefined, []);

  /* ---------------- Deck engine ---------------- */
  const setDeckError = (idx: 0 | 1, msg: string | null) => {
    setDeckErrors((prev) => {
      const next: [string | null, string | null] = [prev[0], prev[1]];
      next[idx] = msg;
      return next;
    });
  };

  const loadDeck = async (idx: 0 | 1, track: Track) => {
    const ctx = await ensureCtx();
    stopDeck(idx);
    setDeckError(idx, null);
    try {
      const res = await fetch(`/media/${track.filePath.split("/").pop()}`);
      if (!res.ok) throw new Error(`Could not load file (${res.status})`);
      const buf = await res.arrayBuffer();
      const audio = await ctx.decodeAudioData(buf);
      setDecks((ds) => {
        const next = [...ds] as [DeckState, DeckState];
        next[idx] = { ...EMPTY_DECK, track, buffer: audio, volume: ds[idx].volume };
        return next;
      });
    } catch (err) {
      setDeckError(idx, err instanceof Error ? err.message : "Could not load track");
    }
  };

  const disconnectDeckChain = (idx: 0 | 1) => {
    for (const node of deckChain.current[idx] ?? []) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    deckChain.current[idx] = [];
  };

  const stopDeck = (idx: 0 | 1, keepOffset = false) => {
    const key = `deck${idx}`;
    const src = nodes.current[key] as AudioBufferSourceNode | undefined;
    try {
      src?.stop();
    } catch {
      // Already stopped/ended, or never started — never let this wedge the deck.
    }
    nodes.current[key] = undefined as unknown as AudioNode;
    disconnectDeckChain(idx);
    duckRef.current[idx] = null;
    setDecks((ds) => {
      const next = [...ds] as [DeckState, DeckState];
      next[idx] = { ...next[idx], playing: false, offset: keepOffset ? next[idx].offset : 0, startedAt: 0, startOffset: 0 };
      return next;
    });
  };

  const pauseDeck = (idx: 0 | 1) => {
    const ctx = ctxRef.current;
    const d = decks[idx];
    const pos = ctx && d.playing ? d.startOffset + (ctx.currentTime - d.startedAt) : d.offset;
    stopDeck(idx, true);
    setDecks((ds) => {
      const next = [...ds] as [DeckState, DeckState];
      next[idx] = { ...next[idx], playing: false, offset: Math.max(0, pos) };
      return next;
    });
  };

  const playDeck = async (idx: 0 | 1, seekTo?: number) => {
    const deck = decks[idx];
    if (!deck.buffer) return;
    try {
      const ctx = await ensureCtx();
      if (ctx.state !== "running") await ctx.resume().catch(() => {});
      setDeckError(idx, null);
      stopDeck(idx);
      const src = ctx.createBufferSource();
      src.buffer = deck.buffer;
      const gain = ctx.createGain();
      gain.gain.value = deck.volume;
      const duck = ctx.createGain();
      duck.gain.value = micOn ? 0.28 : 1; // honour current duck state immediately
      duckRef.current[idx] = duck;
      src.connect(gain);
      gain.connect(duck);
      duck.connect(nodes.current.master as GainNode);
      // PFL -> monitor
      const mon = nodes.current.monitor as GainNode;
      const pflGain = ctx.createGain();
      pflGain.gain.value = 0.8;
      gain.connect(pflGain);
      pflGain.connect(mon);
      deckChain.current[idx] = [gain, duck, pflGain];
      nodes.current[`deck${idx}`] = src;
      const maxOffset = Math.max(0, deck.buffer.duration - 0.05);
      const startOffset = Math.min(Math.max(0, seekTo ?? deck.offset), maxOffset);
      // Assign onended BEFORE start so an instantly-ending buffer can't be missed.
      src.onended = () => {
        if (nodes.current[`deck${idx}`] === (src as unknown as AudioNode)) {
          nodes.current[`deck${idx}`] = undefined as unknown as AudioNode;
          disconnectDeckChain(idx);
          setDecks((ds) => {
            const n = [...ds] as [DeckState, DeckState];
            n[idx] = { ...n[idx], playing: false, offset: 0, startedAt: 0, startOffset: 0 };
            return n;
          });
        }
      };
      src.start(0, startOffset);
      setDecks((ds) => {
        const next = [...ds] as [DeckState, DeckState];
        next[idx] = { ...next[idx], playing: true, offset: startOffset, startedAt: ctx.currentTime, startOffset };
        return next;
      });
    } catch (err) {
      // Leave the deck in a clean, usable state even if playback failed.
      try {
        (nodes.current[`deck${idx}`] as AudioBufferSourceNode | undefined)?.stop();
      } catch {
        /* ignore */
      }
      nodes.current[`deck${idx}`] = undefined as unknown as AudioNode;
      disconnectDeckChain(idx);
      setDecks((ds) => {
        const next = [...ds] as [DeckState, DeckState];
        next[idx] = { ...next[idx], playing: false };
        return next;
      });
      setDeckError(idx, err instanceof Error ? err.message : "Could not start playback");
    }
  };

  // Position tracker: derives the true position from the AudioContext clock (no
  // drift) and only flips to "stopped" when the real position reaches the end.
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      setNow(Date.now());
      const ctx = ctxRef.current;
      // Self-heal: browsers can suspend the AudioContext after inactivity; nudge
      // it back so decks/mic keep working during a long live show.
      if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
      setDecks((ds) => {
        let changed = false;
        const next = [...ds] as [DeckState, DeckState];
        for (let i = 0; i < 2; i++) {
          const d = next[i]!;
          if (d.playing && d.buffer && ctx) {
            const pos = d.startOffset + (ctx.currentTime - d.startedAt);
            if (pos >= d.buffer.duration - 0.05) {
              next[i] = { ...d, playing: false, offset: 0, startedAt: 0, startOffset: 0 };
            } else {
              next[i] = { ...d, offset: Math.max(0, pos) };
            }
            changed = true;
          }
        }
        return changed ? next : ds;
      });
    }, 250);
    return () => clearInterval(id);
  }, [ready]);
  void now;

  /* ---------------- Carts ---------------- */
  const decodeTrack = async (track: Track) => {
    const ctx = await ensureCtx();
    const res = await fetch(`/media/${track.filePath.split("/").pop()}`);
    if (!res.ok) throw new Error("Failed to load audio");
    const buf = await res.arrayBuffer();
    return ctx.decodeAudioData(buf);
  };

  const loadCart = async (idx: number, track: Track) => {
    const ctx = await ensureCtx();
    void ctx.resume().catch(() => {});
    const audio = await decodeTrack(track);
    setCarts((cs) => cs.map((c, i) => (i === idx ? { ...c, track, buffer: audio, playing: false } : c)));
    // Remember this cart so it comes back after leaving the page.
    try {
      const raw = localStorage.getItem(CARTS_KEY);
      const saved: Array<{ idx: number; track: Track } | null> = raw ? JSON.parse(raw) : [];
      const next = saved.filter((s) => s && s.idx !== idx);
      next.push({ idx, track });
      localStorage.setItem(CARTS_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable — persistence is best-effort
    }
  };

  // Restore saved carts when the page is opened. Track names appear instantly;
  // the audio buffers decode in the background (playback resumes on first tap).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CARTS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Array<{ idx: number; track: Track } | null>;
      const restored: Record<number, Track> = {};
      for (const item of saved) {
        if (item && item.track && typeof item.idx === "number" && item.idx >= 0 && item.idx < 8) {
          restored[item.idx] = item.track;
        }
      }
      if (Object.keys(restored).length === 0) return;
      setCarts((cs) => cs.map((c, i) => (restored[i] ? { ...c, track: restored[i] } : c)));
      for (const [idxStr, track] of Object.entries(restored)) {
        decodeTrack(track)
          .then((audio) => setCarts((cs) => cs.map((c, i) => (i === Number(idxStr) ? { ...c, buffer: audio } : c))))
          .catch(() => {});
      }
    } catch {
      // corrupt storage — start fresh
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browsers create the AudioContext suspended until a user gesture; resume it
  // on the first interaction so restored cart buffers can play.
  useEffect(() => {
    const resume = () => {
      const c = ctxRef.current;
      if (c && c.state === "suspended") void c.resume().catch(() => {});
    };
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
    return () => {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
    };
  }, []);

  const playCart = async (idx: number) => {
    const cart = carts[idx]!;
    const ctx = await ensureCtx();
    void ctx.resume().catch(() => {});
    // Buffer may not be decoded yet (e.g. restored cart that's still loading) —
    // decode on demand so the cart still works.
    let buffer = cart.buffer;
    if (!buffer && cart.track) {
      try {
        buffer = await decodeTrack(cart.track);
        setCarts((cs) => cs.map((c, i) => (i === idx ? { ...c, buffer } : c)));
      } catch {
        return;
      }
    }
    if (!buffer) return;
    const key = `cart${idx}`;
    (nodes.current[key] as AudioBufferSourceNode | undefined)?.stop();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = cartVol;
    const duck = ctx.createGain();
    duck.gain.value = 1;
    duckRef.current[idx < 4 ? 2 : 3] = duck;
    src.connect(gain);
    gain.connect(duck);
    duck.connect(nodes.current.master as GainNode);
    nodes.current[key] = src;
    src.start(0);
    cartClock.current[idx] = { start: ctx.currentTime, duration: buffer.duration };
    setCarts((cs) => cs.map((c, i) => (i === idx ? { ...c, playing: true } : c)));
    src.onended = () => {
      cartClock.current[idx] = null;
      setCarts((cs) => cs.map((c, i) => (i === idx ? { ...c, playing: false } : c)));
    };
  };

  /* ---------------- PFL ---------------- */
  const togglePfl = (key: string) => {
    setPfl((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };

  const remaining = (d: DeckState) => (d.playing && d.buffer ? Math.max(0, d.buffer.duration - d.offset) : null);

  return (
    <>
      <PageHead
        title="Live Studio"
        sub="A real mixer in your dashboard — mic, two music decks and eight jingle carts"
        actions={
          live ? (
            <Button variant="danger" onClick={stopLive}>■ Stop live</Button>
          ) : (
            <Button variant="primary" disabled={me?.user.role === "dj" && !!assignedSlots && !!stationSettings && !currentDjSlot(assignedSlots.slots, stationSettings.settings.timezone)} onClick={() => setGoLiveOpen(true)}>● Go live</Button>
          )
        }
      />
      {!ready ? <Card className="live-notice"><Spinner /> Starting audio engine…</Card> : null}
      {me?.user.role === "dj" && assignedSlots && stationSettings && !currentDjSlot(assignedSlots.slots, stationSettings.settings.timezone) ? <Card className="live-notice"><p className="hint" style={{ margin: 0 }}>You are outside your allocated live slot. Live Studio will be available during your assigned day and time.</p></Card> : null}

      {live ? (
        <Card className="live-notice">
          <Badge tone="live">🔴 ON AIR — you are broadcasting now</Badge>
          <span className="muted small" style={{ marginLeft: 10 }}>
            Automation stepped aside. Close the live connection and your programming resumes.
          </span>
        </Card>
      ) : null}

      {/* Decks */}
      <div className="grid grid-2 live-decks" style={{ marginBottom: 16 }}>
        {[0, 1].map((idx) => {
          const d = decks[idx]!;
          const rem = remaining(d);
          return (
            <div key={idx} className="deck">
              <div className="track-meta">
                <div className="track-meta-main">
                  <div className="deck-label" style={{ fontSize: 13, color: "var(--muted)" }}>DECK {idx + 1}</div>
                  <strong className="deck-title" title={d.track?.title ?? undefined}>{d.track ? d.track.title : "No track loaded"}</strong>
                  <div className="small muted deck-artist" title={d.track?.artist ?? undefined}>{d.track?.artist ?? ""}</div>
                </div>
                <div className="track-meta-side" style={{ textAlign: "right" }}>
                  {rem != null ? (
                    <div className={`countdown ${rem < 15 ? "amber" : ""}`}>{fmt(rem)}</div>
                  ) : (
                    <div className="countdown muted">--:--</div>
                  )}
                  <div className="small muted">{d.track ? fmt(d.buffer!.duration) : ""}</div>
                </div>
              </div>
              {d.buffer ? (
                <Waveform buffer={d.buffer} offset={d.playing ? d.offset : 0} seekTo={(s) => void playDeck(idx as 0 | 1, s)} />
              ) : (
                <div className="waveform waveform-empty" aria-hidden="true" />
              )}
              <div className="row" style={{ marginTop: 10, justifyContent: "center" }}>
                <Button className="btn-sm" onClick={() => setDeckPicker(idx as 0 | 1)}>Load</Button>
                {d.buffer && !d.playing ? <Button className="btn-sm" variant="primary" onClick={() => void playDeck(idx as 0 | 1)}>▶ Play</Button> : null}
                {d.playing ? <Button className="btn-sm" onClick={() => pauseDeck(idx as 0 | 1)}>⏸ Pause</Button> : null}
                <Button className="btn-sm" onClick={() => stopDeck(idx as 0 | 1)}>■ Stop</Button>
                <span className={`pfl ${pfl.has(`deck${idx}`) ? "on" : ""}`} onClick={() => togglePfl(`deck${idx}`)}>PFL</span>
              </div>
              {deckErrors[idx] ? <p className="hint" style={{ color: "var(--danger)", margin: "6px 0 0" }}>{deckErrors[idx]}</p> : null}
              <div className="row" style={{ marginTop: 8 }}>
                <span className="small muted" style={{ width: 80 }}>Volume</span>
                <input type="range" min={0} max={1.2} step={0.01} value={d.volume}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setDecks((ds) => {
                      const n = [...ds] as [DeckState, DeckState];
                      n[idx] = { ...n[idx], volume: v };
                      return n;
                    });
                  }} style={{ flex: 1 }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Carts */}
      <Card title="Jingle carts — 1–4 on Cart A, 5–8 on Cart B">
        <div className="carts">
          {carts.map((c, i) => (
            <div key={i} className={`cart${c.playing ? " cart-playing" : ""}`} onClick={() => void playCart(i)} onContextMenu={(e) => { e.preventDefault(); setCartPicker(i); }}>
              <div className="cart-label">{i < 4 ? "J1" : "J2"} · {i + 1}</div>
              <div className="cart-name">{c.track ? c.track.title : "Empty — right-click to load"}</div>
              {/* Always rendered so the card never changes height when a jingle
                  starts — idle it reads as the jingle's length, playing it
                  becomes the live cue countdown. */}
              {(() => {
                const clk = c.playing ? cartClock.current[i] : null;
                const ctx = ctxRef.current;
                const rem = clk && ctx ? Math.max(0, clk.duration - (ctx.currentTime - clk.start)) : null;
                const pct = clk ? Math.max(0, Math.min(100, ((clk.duration - (rem ?? clk.duration)) / clk.duration) * 100)) : 0;
                const soon = rem != null && rem <= 3;
                return (
                  <div className={`cart-cue${c.playing ? " is-playing" : ""}`}>
                    <div className="cart-cue-bar"><div className={`cart-cue-fill${soon ? " is-soon" : ""}`} style={{ width: `${pct}%` }} /></div>
                    <div className={`cart-cue-time${soon ? " is-soon" : ""}`}>
                      {rem != null ? `${rem.toFixed(1)}s` : c.track ? fmt(c.track.durationSeconds) : "—"}
                    </div>
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="small muted" style={{ width: 90 }}>Cart volume</span>
          <input type="range" min={0} max={1.2} step={0.01} value={cartVol} onChange={(e) => setCartVol(Number(e.target.value))} style={{ flex: 1 }} />
        </div>
      </Card>

      {/* Mic + master */}
      <div className="grid grid-3 live-studio-bottom-grid" style={{ marginTop: 16 }}>
        <Card className="live-studio-bottom-card" title="Microphone">
          <div className="row">
            <span className="small muted" style={{ width: 60 }}>Gain</span>
            <input type="range" min={0} max={1.5} step={0.01} value={micVol} onChange={(e) => setMicVol(Number(e.target.value))} style={{ flex: 1 }} />
          </div>
          <div className="master-vu-row">
            <span className="small muted" style={{ width: 60 }}>Level</span>
            <VUMeter getAnalyser={getMicMeter} />
          </div>
          <Button variant={micOn ? "danger" : "primary"} onClick={() => void toggleMic()}>{micOn ? "Mute mic" : "Open mic"}</Button>
          <p className="hint" style={{ marginBottom: 0 }}>
            {micOn
              ? "Music ducks automatically while the mic is open. Keep the mic level under the red on your loudest delivery."
              : "Open the mic — its level meter fills as you speak."}
          </p>
        </Card>
        <Card className="live-studio-bottom-card" title="Master">
          <div className="row">
            <span className="small muted" style={{ width: 60 }}>Level</span>
            <input type="range" min={0} max={1} step={0.01} value={masterVol} onChange={(e) => setMasterVol(Number(e.target.value))} style={{ flex: 1 }} />
          </div>
          <div className="master-vu-row">
            <span className="small muted" style={{ width: 60 }}>Output</span>
            <VUMeter getAnalyser={getMasterMeter} />
          </div>
          <p className="hint" style={{ marginBottom: 0 }}>
            {pfl.size > 0 ? "Monitoring PFL — output muted on air. (PFL routes to your headphones only.)" : "Everything you hear is what goes out."}
          </p>
        </Card>
        <Card className="live-studio-bottom-card" title="Going live">
          <p className="hint" style={{ marginTop: 0 }}>
            Press <strong>Go live</strong> to take over the broadcast from your browser. When you stop,
            the AutoDJ resumes the scheduled programming — no dead air.
          </p>
          <Button variant={live ? "danger" : "primary"} onClick={live ? stopLive : () => setGoLiveOpen(true)}>
            {live ? "Stop broadcasting" : "Go live"}
          </Button>
        </Card>
      </div>

      {goLiveOpen ? (
        <Modal
          open
          title="Go live"
          onClose={() => setGoLiveOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setGoLiveOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => startLive(goLiveShow)}>● Start broadcast</Button>
            </>
          }
        >
          <Field label="Show name" hint="Shown on the public player and widgets while you're live. Leave empty to use the scheduled show, or no name.">
            <Input
              autoFocus
              value={goLiveShow}
              maxLength={80}
              placeholder="e.g. Saturday Night Live"
              onChange={(e) => setGoLiveShow(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") startLive(goLiveShow); }}
            />
          </Field>
        </Modal>
      ) : null}

      {deckPicker !== null ? (
        <TrackPicker title={`Load deck ${deckPicker + 1}`} onClose={() => setDeckPicker(null)}
          onPick={(t) => { void loadDeck(deckPicker as 0 | 1, t); setDeckPicker(null); }} />
      ) : null}
      {cartPicker !== null ? (
        <TrackPicker title={`Load cart ${cartPicker + 1} — jingles`} kind="jingle" onClose={() => setCartPicker(null)}
          onPick={(t) => { void loadCart(cartPicker, t); setCartPicker(null); }} />
      ) : null}
    </>
  );
}

function currentDjSlot(slots: Djslot[], timezone = "UTC"): Djslot | null {  const now = zonedParts(Date.now(), timezone);
  return slots.find((slot) => (slot.dayOfWeek === null || slot.dayOfWeek === now.dayOfWeek) && slot.startMinutes <= now.minutesOfDay && now.minutesOfDay < slot.endMinutes) ?? null;
}

/** Segmented LED VU meter showing the level being sent on air. */
function VUMeter({ getAnalyser }: { getAnalyser: () => AnalyserNode | undefined }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const g = cv.getContext("2d");
    if (!g) return;

    const dpr = window.devicePixelRatio || 1;
    let raf = 0;
    let hold = -60; // smoothed display level in dB (fast rise, slow fall)
    let holdPeak = -60; // peak hold cap, e.g. the highest recent peak
    let peakAge = 0;
    let lastT = performance.now();

    const resize = () => {
      cv.width = Math.max(1, Math.round(cv.clientWidth * dpr));
      cv.height = Math.max(1, Math.round(cv.clientHeight * dpr));
    };
    resize();
    window.addEventListener("resize", resize);

    const data = new Uint8Array(1024);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const an = getAnalyser();
      // No analyser yet (e.g. mic not opened for the first time) — still draw the
      // idle LED squares so the meter looks the same as the Master meter.
      if (!an) {
        drawMeter(g, cv.width, cv.height, dpr, -60, -60);
        return;
      }
      an.getByteTimeDomainData(data);

      let peak = 0;
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - 128) / 128;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sum += a * a;
      }
      const rms = Math.sqrt(sum / data.length);
      // Blend peak and average so the meter reads like a VU but still reacts to
      // transients; gate to silence when nothing is playing.
      const fast = Math.max(peak, rms * 1.7);
      let db = fast > 0 ? 20 * Math.log10(Math.max(fast, 1e-5)) : -90;
      if (rms < 0.0006) db = -70;

      const now = performance.now();
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;

      // Ballistics: rise instantly, fall at ~30 dB/s.
      if (db > hold) hold = db;
      else hold = Math.max(-60, hold - 30 * dt);
      // Peak-hold: remember the top for a moment so you can see overs.
      if (db > holdPeak) { holdPeak = db; peakAge = 0; } else { peakAge += dt; }
      if (peakAge > 1.2) holdPeak = -60;

      const disp = Math.max(hold, db);

      drawMeter(g, cv.width, cv.height, dpr, disp, holdPeak);
    };

    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getAnalyser]);

  return <canvas ref={ref} className="master-vu" role="img" aria-label="On-air output level" />;
}

/** Draws the lit segments onto the (device-pixel) canvas. */
function drawMeter(g: CanvasRenderingContext2D, w: number, h: number, dpr: number, levelDb: number, peakDb: number): void {
  const SEG = 42;
  const gap = Math.max(1, Math.round(2 * dpr));
  const track = 2 * dpr;
  const segW = (w - gap * (SEG - 1) - track * 2) / SEG;
  const x0 = track;
  const y0 = track;
  const H = h - track * 2;

  const dbFloor = -50;
  const dbCeil = 0;
  const span = dbCeil - dbFloor;
  const frac = Math.max(0, Math.min(1, (levelDb - dbFloor) / span));
  const lit = frac * SEG;

  const zone = (i: number): string => {
    const t = (i + 0.5) / SEG;
    if (t > 0.9) return "#ff3b30"; // red — top (peak/limit zone)
    if (t > 0.68) return "#ffb400"; // amber
    return "#2fd158"; // green
  };
  const offColor = "rgba(140,140,160,0.22)";

  g.clearRect(0, 0, w, h);
  for (let i = 0; i < SEG; i++) {
    const x = x0 + i * (segW + gap);
    const on = lit >= i + 1 || (lit > i && lit < i + 1);
    g.fillStyle = on ? zone(i) : offColor;
    g.fillRect(x, y0, segW, H);
  }

  // Peak-hold marker (a thin light bar at the highest recent level).
  if (peakDb > dbFloor) {
    const pf = Math.max(0, Math.min(1, (peakDb - dbFloor) / span));
    const px = Math.round(x0 + pf * (w - x0 - x0));
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.fillRect(px - 1, y0, 2, H);
  }
}

function TrackPicker({ title, onClose, onPick, kind = "music" }: { title: string; onClose: () => void; onPick: (t: Track) => void; kind?: string }) {
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Track[]>([]);
  const { data: folders } = useFetch(() => api<{ folders: Array<{ name: string; count: number }>; unfiled: number }>("/folders"));
  const { data, loading } = useFetch(
    () => api<{ tracks: Track[]; total: number }>(`/tracks?search=${encodeURIComponent(search)}&kind=${kind}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}&pageSize=200&page=${page}`),
    [search, kind, folder, page],
  );

  useEffect(() => {
    if (!data) return;
    setItems((prev) => (page === 1 ? data.tracks : [...prev, ...data.tracks]));
  }, [data, page]);

  // Audition: preview a track straight from the list before loading it onto a deck.
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const stopPreview = () => {
    const a = previewRef.current;
    if (a) {
      a.pause();
      a.src = "";
    }
    previewRef.current = null;
    setPreviewId(null);
  };

  const togglePreview = (t: Track) => {
    if (previewId === t.id) {
      stopPreview();
      return;
    }
    stopPreview();
    const fileName = t.filePath.split("/").pop() ?? t.filePath;
    const audio = new Audio(`/media/${encodeURIComponent(fileName)}`);
    audio.preload = "auto";
    audio.onended = () => {
      if (previewRef.current === audio) stopPreview();
    };
    audio.onerror = () => {
      if (previewRef.current === audio) stopPreview();
    };
    previewRef.current = audio;
    setPreviewId(t.id);
    void audio.play().catch(() => stopPreview());
  };

  useEffect(() => stopPreview, []);

  const total = data?.total ?? 0;
  const changeFilter = (fn: () => void) => { fn(); setPage(1); };

  return (
    <Modal open onClose={() => { stopPreview(); onClose(); }} title={title}>
      <div className="form-row">
        <Field label="Folder">
          <Select value={folder} onChange={(e) => changeFilter(() => setFolder(e.target.value))}>
            <option value="">All folders</option>
            <option value="unfiled">Unfiled</option>
            {folders?.folders.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.count})</option>)}
          </Select>
        </Field>
        <Field label="Search">
          <Input autoFocus value={search} onChange={(e) => changeFilter(() => setSearch(e.target.value))} placeholder="Search tracks…" />
        </Field>
      </div>
      <div className="small muted" style={{ marginBottom: 6 }}>{total} {kind === "music" ? "track" : kind === "jingle" ? "jingle" : "item"}{total === 1 ? "" : "s"}{folder === "unfiled" ? " (unfiled)" : folder ? ` in “${folder}”` : ""}</div>
      {loading && page === 1 ? <Spinner /> : null}
      <div style={{ maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((t) => (
          <div key={t.id} className="row" style={{ gap: 6, alignItems: "stretch" }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={previewId === t.id ? "Stop preview" : "Preview track"}
              style={{ flexShrink: 0 }}
              onClick={() => togglePreview(t)}
            >
              {previewId === t.id ? "⏸" : "▶"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ flex: 1, justifyContent: "space-between", minWidth: 0 }}
              onClick={() => { stopPreview(); onPick(t); }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <strong>{t.title}</strong> <span className="muted">— {t.artist}</span>
              </span>
              <span className="mono small muted" style={{ flexShrink: 0 }}>{fmt(t.durationSeconds)}{t.folder ? ` · ${t.folder}` : ""}</span>
            </button>
          </div>
        ))}
        {!loading && items.length === 0 ? <div className="empty">No tracks found. Try another folder or search.</div> : null}
        {items.length > 0 && items.length < total ? (
          <button className="btn btn-ghost" style={{ marginTop: 6 }} disabled={loading} onClick={() => setPage((p) => p + 1)}>
            {loading ? "Loading…" : `Load more (${total - items.length} remaining)`}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Waveform peak cache — computing peaks scans every sample of the track, so we
// do it once per buffer and reuse it for every playhead redraw.
const waveformPeaks = new WeakMap<AudioBuffer, Float32Array>();

function Waveform({ buffer, offset, seekTo }: { buffer: AudioBuffer; offset: number; seekTo: (s: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    let peaks = waveformPeaks.get(buffer);
    if (!peaks) {
      const data = buffer.getChannelData(0);
      const N = 240;
      peaks = new Float32Array(N);
      const step = Math.floor(data.length / N) || 1;
      for (let i = 0; i < N; i++) {
        let max = 0;
        const from = i * step;
        const to = Math.min((i + 1) * step, data.length);
        for (let j = from; j < to; j++) {
          const a = Math.abs(data[j]!);
          if (a > max) max = a;
        }
        peaks[i] = max;
      }
      waveformPeaks.set(buffer, peaks);
    }

    const N = peaks.length;
    ctx.fillStyle = "#38bdf8";
    for (let i = 0; i < N; i++) {
      const barH = Math.max(2, peaks[i]! * h * 0.9);
      ctx.fillRect((i / N) * w, (h - barH) / 2, w / N - 1, barH);
    }
    // playhead
    if (offset > 0) {
      ctx.fillStyle = "#fbbf24";
      ctx.fillRect((offset / buffer.duration) * w - 1, 0, 2, h);
    }
  }, [buffer, offset]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    seekTo((x / rect.width) * buffer.duration);
  };

  return <canvas ref={ref} className="waveform" onClick={onClick} />;
}

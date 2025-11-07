const { useState, useEffect, useMemo, useRef, useCallback } = React;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const FPS_LIMIT_MIN = 10;
const FPS_LIMIT_MAX = 260;
const LANGUAGE_PRESETS = [
  { code: "ru_ru", label: "Русский (Россия)" },
  { code: "uk_ua", label: "Українська (Україна)" },
  { code: "be_by", label: "Беларуская (Беларусь)" },
  { code: "en_us", label: "English (US)" },
  { code: "en_gb", label: "English (UK)" },
  { code: "de_de", label: "Deutsch (Deutschland)" },
  { code: "pl_pl", label: "Polski (Polska)" },
  { code: "es_es", label: "Español (España)" },
  { code: "pt_br", label: "Português (Brasil)" },
  { code: "fr_fr", label: "Français (France)" },
  { code: "kk_kz", label: "Қазақ тілі (Қазақстан)" },
  { code: "tr_tr", label: "Türkçe (Türkiye)" },
  { code: "zh_cn", label: "简体中文 (中国)" },
  { code: "ja_jp", label: "日本語 (日本)" }
];

const DEFAULT_GAME_OPTIONS_STATE = {
  fpsLimit: FPS_LIMIT_MAX,
  vsync: true,
  language: "ru_ru",
  updatedAt: null,
  sources: null
};

const normalizeGameOptionsState = (raw) => {
  const normalized = { ...DEFAULT_GAME_OPTIONS_STATE };
  if (!raw || typeof raw !== "object") {
    return normalized;
  }
  const fpsValue = Number(raw.fpsLimit);
  if (Number.isFinite(fpsValue)) {
    normalized.fpsLimit = clamp(Math.round(fpsValue), FPS_LIMIT_MIN, FPS_LIMIT_MAX);
  }
  if (raw.vsync !== undefined) {
    normalized.vsync = Boolean(raw.vsync);
  }
  if (typeof raw.language === "string" && raw.language.trim()) {
    normalized.language = raw.language.trim().toLowerCase();
  }
  normalized.updatedAt = raw.updatedAt || Date.now();
  normalized.sources = raw.sources || null;
  return normalized;
};

const sanitizeLanguageInput = (value) =>
  typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/-/g, "_")
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/_+/g, "_")
    : "";

const MIN_SERVER_REFRESH_MS = 10000;
const PROFILE_GRADIENTS = [
  "linear-gradient(135deg, #22d3ee 0%, #6366f1 100%)",
  "linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)",
  "linear-gradient(135deg, #f97316 0%, #ef4444 100%)",
  "linear-gradient(135deg, #34d399 0%, #10b981 100%)",
  "linear-gradient(135deg, #38bdf8 0%, #818cf8 100%)",
  "linear-gradient(135deg, #f472b6 0%, #6366f1 100%)",
];

const PROFILE_GLYPHS = ["🧙", "🛡️", "🐉", "🌌", "🧊", "🦊"];

const sumCharCodes = (value) =>
  (value || "")
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);

const getProfileVisuals = (profile = {}, index = 0) => {
  const seed =
    sumCharCodes(profile.id || profile.label || profile.nickname) + index;
  const gradient = PROFILE_GRADIENTS[seed % PROFILE_GRADIENTS.length];
  const glyph = PROFILE_GLYPHS[seed % PROFILE_GLYPHS.length];
  const base =
    (profile.nickname || profile.label || "Игрок").trim() || "Игрок";
  const initial = base.slice(0, 1).toUpperCase();
  return { gradient, glyph, initial };
};

const getTimeGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 5) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
};


const getDayPhase = (date = new Date()) => {
  const hour = date.getHours();
  if (hour >= 5 && hour < 9) return "sunrise";
  if (hour >= 9 && hour < 17) return "day";
  if (hour >= 17 && hour < 21) return "sunset";
  return "night";
};

const DayPhaseIcon = {
  sunrise: () => (
    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M10 34h28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M14 29c2.4-4.2 6.8-7 12-7s9.6 2.8 12 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24" cy="26" r="8" fill="#fbbf24" />
      <path d="M24 10v5" stroke="#facc15" strokeWidth="2" strokeLinecap="round" />
      <path d="M13 15l3.5 3.5" stroke="#facc15" strokeWidth="2" strokeLinecap="round" />
      <path d="M35 15l-3.5 3.5" stroke="#facc15" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  day: () => (
    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="24" cy="24" r="10" fill="#fde047" />
      <g stroke="#fde047" strokeWidth="2" strokeLinecap="round">
        <path d="M24 8v6" />
        <path d="M24 34v6" />
        <path d="M8 24h6" />
        <path d="M34 24h6" />
        <path d="M14 14l4.2 4.2" />
        <path d="M33.8 33.8L29.6 29.6" />
        <path d="M33.8 14.2L29.6 18.4" />
        <path d="M14.2 33.8l4.2-4.2" />
      </g>
    </svg>
  ),
  sunset: () => (
    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M10 34h28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M14 29c2.4-4.2 6.8-7 12-7s9.6 2.8 12 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24" cy="26" r="8" fill="#fb7185" />
      <path d="M24 9v5" stroke="#f472b6" strokeWidth="2" strokeLinecap="round" />
      <path d="M13 15l3.5 3.5" stroke="#f472b6" strokeWidth="2" strokeLinecap="round" />
      <path d="M35 15l-3.5 3.5" stroke="#f472b6" strokeWidth="2" strokeLinecap="round" />
      <path d="M10 39h28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  night: () => (
    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M30.5 12.5C28.1 13.8 26.5 16.3 26.5 19c0 5 4 9 9 9 1.4 0 2.7-.3 3.9-.9C38.5 32.4 32.9 37 26 37 17.7 37 11 30.3 11 22c0-6.9 4.6-12.5 10.9-14.4-.6 1.4-.9 2.9-.9 4.4 0 5 4 9 9 9 1.5 0 3-.4 4.3-1.1z" fill="#c7d2fe" />
      <circle cx="16" cy="15" r="1.8" fill="#e0e7ff" />
      <circle cx="33" cy="11" r="1.2" fill="#e0e7ff" />
      <circle cx="18" cy="32" r="1.2" fill="#e0e7ff" />
    </svg>
  ),
};

const DAY_PHASES = {
  sunrise: {
    label: "Рассвет",
    hint: "05:00 - 08:59",
    glow: "radial-gradient(120% 120% at 100% 0%, rgba(253, 186, 116, 0.45), transparent 55%)",
    cardBackground: "linear-gradient(135deg, rgba(253, 186, 116, 0.22), rgba(59, 130, 246, 0.15))",
    cardBorder: "rgba(253, 186, 116, 0.45)",
    cardShadow: "0 16px 32px rgba(253, 186, 116, 0.28)",
    iconColor: "#fde68a",
    icon: DayPhaseIcon.sunrise,
  },
  day: {
    label: "День",
    hint: "",
    glow: "radial-gradient(120% 120% at 100% 0%, rgba(59, 130, 246, 0.35), transparent 55%)",
    cardBackground: "linear-gradient(135deg, rgba(59, 130, 246, 0.22), rgba(56, 189, 248, 0.18))",
    cardBorder: "rgba(96, 165, 250, 0.45)",
    cardShadow: "0 16px 32px rgba(59, 130, 246, 0.25)",
    iconColor: "#fde047",
    icon: DayPhaseIcon.day,
  },
  sunset: {
    label: "Закат",
    hint: "",
    glow: "radial-gradient(120% 120% at 100% 0%, rgba(249, 168, 212, 0.45), transparent 55%)",
    cardBackground: "linear-gradient(135deg, rgba(244, 114, 182, 0.2), rgba(99, 102, 241, 0.2))",
    cardBorder: "rgba(244, 114, 182, 0.45)",
    cardShadow: "0 16px 32px rgba(244, 114, 182, 0.28)",
    iconColor: "#f9a8d4",
    icon: DayPhaseIcon.sunset,
  },
  night: {
    label: "Ночь",
    hint: "",
    glow: "radial-gradient(120% 120% at 100% 0%, rgba(45, 212, 191, 0.35), transparent 55%)",
    cardBackground: "linear-gradient(135deg, rgba(45, 212, 191, 0.18), rgba(79, 70, 229, 0.2))",
    cardBorder: "rgba(129, 140, 248, 0.45)",
    cardShadow: "0 16px 32px rgba(129, 140, 248, 0.25)",
    iconColor: "#c7d2fe",
icon: DayPhaseIcon.night,
    },
  };

  const AmbientBackground = ({
    imageSrc,
    glassTint,
    glassOpacity,
    blurRadius,
    fireflyConfig,
  }) => {
    const containerRef = useRef(null);
    const fireflyRef = useRef(null);

    useEffect(() => {
const container = containerRef.current;
const orb = fireflyRef.current;
if (!container || !orb) return undefined;

const padding = 56;
let rect = container.getBoundingClientRect();
if (!rect || rect.width <= 0 || rect.height <= 0) {
  rect = {
    width: container.offsetWidth || 1,
    height: container.offsetHeight || 1,
  };
}

const speedMultiplier = Math.max(
  0.4,
  Math.min(2.8, Number(fireflyConfig?.speed) || 1)
);
const stepBase = 0.013 * speedMultiplier;

let frameId = null;
let lastTimestamp = performance.now();
let position = {
  x: rect.width * 0.55,
  y: rect.height * 0.45,
};
let target = { ...position };

const pickTarget = () => {
  rect = container.getBoundingClientRect();
  const width = Math.max(0, rect.width - padding * 2);
  const height = Math.max(0, rect.height - padding * 2);
  target = {
    x: padding + Math.random() * (width || 0),
    y: padding + Math.random() * (height || 0),
  };
};

const animate = (timestamp) => {
  frameId = requestAnimationFrame(animate);
  const dt = Math.max(16, Math.min(120, timestamp - lastTimestamp));
  lastTimestamp = timestamp;

  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const lerpFactor = Math.min(0.25, stepBase * (dt / 16.6667));

  position = {
    x: position.x + dx * lerpFactor,
    y: position.y + dy * lerpFactor,
  };

  orb.style.transform = `translate3d(${position.x}px, ${position.y}px, 0) translate(-50%, -50%)`;

  if (!distance || distance < 24) {
    pickTarget();
  }
};

pickTarget();
frameId = requestAnimationFrame(animate);

const handleResize = () => {
  rect = container.getBoundingClientRect();
  position.x = clamp(
    position.x,
    padding,
    Math.max(padding, rect.width - padding)
  );
  position.y = clamp(
    position.y,
    padding,
    Math.max(padding, rect.height - padding)
  );
  pickTarget();
};

window.addEventListener("resize", handleResize);
return () => {
  if (frameId) {
    cancelAnimationFrame(frameId);
  }
  window.removeEventListener("resize", handleResize);
};
    }, [fireflyConfig?.speed, imageSrc]);

    const hasImage = Boolean(imageSrc);
    const overlayColor =
typeof glassTint === "string" && glassTint.trim()
  ? glassTint.trim()
  : "rgba(92, 47, 200, 0.62)";
    const overlayOpacity =
typeof glassOpacity === "number" && !Number.isNaN(glassOpacity)
  ? Math.min(1, Math.max(0, glassOpacity))
  : 0.65;
    const blurValue =
typeof blurRadius === "number" && !Number.isNaN(blurRadius)
  ? Math.max(0, blurRadius)
  : 26;
    const fireflyColor =
fireflyConfig?.color && typeof fireflyConfig.color === "string"
  ? fireflyConfig.color.trim()
  : "rgba(255, 244, 214, 0.85)";
    const rawSize =
fireflyConfig?.size !== undefined
  ? Number(fireflyConfig.size)
  : 120;
    const fireflySize = clamp(rawSize, 60, 320);

    let resolvedImage = imageSrc;
    if (hasImage) {
try {
  resolvedImage = new URL(imageSrc, window.location.href).toString();
} catch {
  resolvedImage = imageSrc;
}
    }

    return (
<div
  className="main-area-background"
  data-has-image={hasImage}
  ref={containerRef}
  style={{
    "--glass-tint": overlayColor,
    "--glass-opacity": overlayOpacity,
    "--glass-blur": `${blurValue}px`,
    "--firefly-color": fireflyColor,
    "--firefly-size": `${fireflySize}px`,
  }}
>
  <div
    className="main-area-background-image"
    style={
      hasImage
        ? { backgroundImage: `url("${resolvedImage}")` }
        : undefined
    }
  />
  <div className="main-area-background-gradient" />
  <div className="main-area-background-glass" />
  <div className="main-area-background-noise" />
  <div className="main-area-firefly" ref={fireflyRef} />
</div>
    );
  };

  function App() {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [modpacks, setModpacks] = useState([]);
  const [activeModpackId, setActiveModpackId] = useState(null);
  const [paths, setPaths] = useState({});
  const [servers, setServers] = useState([]);
  const [serverStatuses, setServerStatuses] = useState({});
  const [nickname, setNickname] = useState("Player");
  const [ram, setRam] = useState(2048);
  const [status, setStatus] = useState("Загрузка…");
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(null);
  const [defaults, setDefaults] = useState({
    ramMb: 2048,
    minRamMb: 1024,
  });
  const [syncing, setSyncing] = useState(false);
  const [downloadingShaders, setDownloadingShaders] = useState(false);
  const [downloadingResources, setDownloadingResources] = useState(false);
  const [theme, setTheme] = useState({});
  const [gameOptions, setGameOptions] = useState(() =>
    normalizeGameOptionsState()
  );
  const [gameOptionsSaving, setGameOptionsSaving] = useState(false);
  const [gameOptionsError, setGameOptionsError] = useState("");
  const [fpsInput, setFpsInput] = useState(
    String(DEFAULT_GAME_OPTIONS_STATE.fpsLimit)
  );
  const [languageInput, setLanguageInput] = useState(
    DEFAULT_GAME_OPTIONS_STATE.language
  );
  const [launching, setLaunching] = useState(false);
  const [updateState, setUpdateState] = useState({
    enabled: false,
    status: "checking",
    needsUpdate: false,
    mandatory: false,
    currentVersion: null,
    latestVersion: null,
    releaseNotes: "",
    releaseTag: null,
    error: null,
    downloading: false,
    progressPercent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    stage: "idle",
    actionError: null
  });
  const [auth, setAuth] = useState({
    status: "unknown",
    allowRegistration: false,
    hasSession: false,
    provider: null,
    baseUrl: null,
  });
  const [authError, setAuthError] = useState("");
  const [authProcessing, setAuthProcessing] = useState(false);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [registerUsername, setRegisterUsername] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState("");
  const [registerPlayerName, setRegisterPlayerName] = useState("");
  const [registerInviteCode, setRegisterInviteCode] = useState("");
  const [registerSubmitting, setRegisterSubmitting] = useState(false);
  const [showRegistration, setShowRegistration] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dayPhase, setDayPhase] = useState(getDayPhase());
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const phaseVisual = useMemo(
    () => DAY_PHASES[dayPhase] || DAY_PHASES.day,
    [dayPhase]
  );
  const timeDisplay = useMemo(
    () =>
      currentTime.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [currentTime]
  );
  const MomentIcon = phaseVisual.icon;
  const fpsMode = useMemo(() => {
    if (gameOptions.vsync) return "vsync";
    if (gameOptions.fpsLimit >= FPS_LIMIT_MAX) return "unlimited";
    return "limit";
  }, [gameOptions]);

  const fpsSummary = useMemo(() => {
    if (gameOptions.vsync) return "V-Sync (монитор)";
    if (gameOptions.fpsLimit >= FPS_LIMIT_MAX) return "Без лимита";
    return `${gameOptions.fpsLimit} FPS`;
  }, [gameOptions]);

  const languageSummary = useMemo(
    () => (gameOptions.language || "ru_ru").toLowerCase(),
    [gameOptions.language]
  );

  const gameOptionsStatusText = useMemo(() => {
    if (gameOptionsSaving) {
      return "Сохраняем настройки...";
    }
    const updatedTime = gameOptions.updatedAt
      ? new Date(gameOptions.updatedAt).toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    const timeSuffix = updatedTime ? ` · обновлено ${updatedTime}` : "";
    return `Применено: ${fpsSummary} · язык ${languageSummary}${timeSuffix}`;
  }, [fpsSummary, languageSummary, gameOptions.updatedAt, gameOptionsSaving]);
  const normalizedTheme = useMemo(() => {
    if (!theme || typeof theme !== "object") {
      return {};
    }
    const next = {};
    const backgroundImage =
      typeof theme.backgroundImage === "string"
        ? theme.backgroundImage.trim()
        : "";
    if (backgroundImage) {
      if (typeof window !== "undefined" && window?.location) {
        try {
          next.backgroundImage = new URL(
            backgroundImage,
            window.location.href
          ).toString();
        } catch {
          next.backgroundImage = backgroundImage;
        }
      } else {
        next.backgroundImage = backgroundImage;
      }
    }
    if (
      typeof theme.glassTint === "string" &&
      theme.glassTint.trim()
    ) {
      next.glassTint = theme.glassTint.trim();
    }
    if (
      typeof theme.glassOpacity === "number" &&
      !Number.isNaN(theme.glassOpacity)
    ) {
      next.glassOpacity = Math.min(
        1,
        Math.max(0, theme.glassOpacity)
      );
    }
    if (
      typeof theme.blurRadius === "number" &&
      !Number.isNaN(theme.blurRadius)
    ) {
      next.blurRadius = Math.max(0, theme.blurRadius);
    }
    if (theme.firefly && typeof theme.firefly === "object") {
      const firefly = {};
      if (
        typeof theme.firefly.color === "string" &&
        theme.firefly.color.trim()
      ) {
        firefly.color = theme.firefly.color.trim();
      }
      if (theme.firefly.size !== undefined) {
        const value = Number(theme.firefly.size);
        if (!Number.isNaN(value) && value > 0) {
          firefly.size = value;
        }
      }
      if (theme.firefly.speed !== undefined) {
        const value = Number(theme.firefly.speed);
        if (!Number.isNaN(value) && value > 0) {
          firefly.speed = value;
        }
      }
      if (Object.keys(firefly).length > 0) {
        next.firefly = firefly;
      }
    }
    return next;
  }, [theme]);
  const logsRef = useRef(null);
  const readyRef = useRef(false);
  const skipSettingsSync = useRef(false);
  const serverTimersRef = useRef({});
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      Object.values(serverTimersRef.current || {}).forEach((timer) => clearInterval(timer));
      serverTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settingsOpen]);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setCurrentTime(now);
      setDayPhase(getDayPhase(now));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  const applyAuthState = useCallback(
    (nextAuth) => {
      if (!nextAuth) {
        setAuth({
          status: "disabled",
          allowRegistration: false,
          hasSession: false,
          provider: null,
          baseUrl: null,
          domain: null,
          selectedProfile: null,
          availableProfiles: [],
          user: null,
          lastAuthAt: null,
        });
        setAuthError("");
        return;
      }

      const normalized = {
        status:
          nextAuth.status ||
          (nextAuth.hasSession ? "authenticated" : "unauthenticated"),
        allowRegistration: !!nextAuth.allowRegistration,
        hasSession: !!nextAuth.hasSession,
        provider: nextAuth.provider || null,
        baseUrl: nextAuth.baseUrl || null,
        domain: nextAuth.domain || null,
        selectedProfile: nextAuth.selectedProfile || null,
        availableProfiles: Array.isArray(nextAuth.availableProfiles)
          ? nextAuth.availableProfiles
          : [],
        user: nextAuth.user || null,
        lastAuthAt: nextAuth.lastAuthAt || null,
      };
      setAuth(normalized);
      setAuthError("");
      if (
        normalized.status === "authenticated" &&
        normalized.selectedProfile?.name
      ) {
        setNickname((prev) => normalized.selectedProfile.name || prev);
      }
    },
    [setAuth, setAuthError, setNickname]
  );

  const applySettings = (
    nextSettings,
    opts = { preserveNickname: false }
  ) => {
    skipSettingsSync.current = true;
    if (!opts.preserveNickname) {
      setNickname(nextSettings.nickname ?? "Player");
    }
    setRam(nextSettings.ramMb ?? defaults.ramMb);
    applyAuthState(nextSettings.auth || null);
  };

  const syncGameOptionsState = useCallback((nextOptions) => {
    const normalized = normalizeGameOptionsState(nextOptions);
    setGameOptions(normalized);
    setFpsInput(String(normalized.fpsLimit));
    setLanguageInput(normalized.language);
  }, []);

  const clampFpsInputValue = useCallback((value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return FPS_LIMIT_MIN;
    }
    return clamp(Math.round(numeric), FPS_LIMIT_MIN, FPS_LIMIT_MAX);
  }, []);

  const persistGameOptions = useCallback(
    async (patch) => {
      if (typeof window.launcher?.updateGameOptions !== "function") {
        return;
      }
      setGameOptionsSaving(true);
      try {
        const response = await window.launcher.updateGameOptions(patch);
        if (response?.ok === false) {
          throw new Error(response.error || "�?�� �?�?���>�?�?�? ����'��?��?�?�?���'�? �?���?�'�?�?�����.");
        }
        syncGameOptionsState(response?.gameOptions || patch);
        setGameOptionsError("");
      } catch (error) {
        setGameOptionsError(
          error?.message ||
            "�?�� �?�?���>�?�?�? ����'��?��?�?�?���'�? �?�?�?�?�?�?�? �?�? options.txt."
        );
      } finally {
        setGameOptionsSaving(false);
      }
    },
    [syncGameOptionsState]
  );

  const handleFpsModeChange = useCallback(
    (mode) => {
      if (mode === "vsync") {
        if (!gameOptions.vsync) {
          persistGameOptions({ vsync: true });
        }
        return;
      }
      if (mode === "unlimited") {
        const needsUpdate =
          gameOptions.vsync || gameOptions.fpsLimit < FPS_LIMIT_MAX;
        if (needsUpdate) {
          persistGameOptions({ vsync: false, unlimited: true });
        }
        return;
      }
      if (mode === "limit") {
        const nextValue = clampFpsInputValue(fpsInput || gameOptions.fpsLimit);
        setFpsInput(String(nextValue));
        persistGameOptions({ vsync: false, fpsLimit: nextValue });
      }
    },
    [gameOptions, fpsInput, clampFpsInputValue, persistGameOptions]
  );

  const commitFpsInput = useCallback(() => {
    const normalized = clampFpsInputValue(fpsInput || gameOptions.fpsLimit);
    setFpsInput(String(normalized));
    if (!gameOptions.vsync && gameOptions.fpsLimit === normalized) {
      return;
    }
    persistGameOptions({ vsync: false, fpsLimit: normalized });
  }, [clampFpsInputValue, fpsInput, gameOptions, persistGameOptions]);

  const handleFpsInputChange = useCallback((value) => {
    setFpsInput(value);
  }, []);

  const handleFpsInputKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter") {
        commitFpsInput();
      }
    },
    [commitFpsInput]
  );

  const handleLanguageBlur = useCallback(() => {
    const normalized = sanitizeLanguageInput(languageInput);
    if (!normalized) {
      setLanguageInput(gameOptions.language);
      return;
    }
    if (normalized === gameOptions.language) {
      setLanguageInput(normalized);
      return;
    }
    persistGameOptions({ language: normalized });
  }, [gameOptions.language, languageInput, persistGameOptions]);

  const handleLanguageInputChange = useCallback((value) => {
    setLanguageInput(value.toLowerCase());
  }, []);

  const applyUpdateSnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    setUpdateState((prev) => {
      const nextStage = snapshot.needsUpdate
        ? prev.stage === "downloading" || prev.stage === "restarting"
          ? prev.stage
          : "pending"
        : "idle";
      const resetProgress = !snapshot.needsUpdate;
      return {
        ...prev,
        enabled: Boolean(snapshot.enabled),
        status: snapshot.status || "unknown",
        needsUpdate: Boolean(snapshot.needsUpdate),
        mandatory: Boolean(snapshot.mandatory),
        currentVersion:
          snapshot.currentVersion ||
          snapshot.current_version ||
          prev.currentVersion,
        latestVersion:
          snapshot.latestVersion ||
          snapshot.latest_version ||
          prev.latestVersion,
        releaseNotes: snapshot.releaseNotes || snapshot.release_notes || "",
        releaseTag: snapshot.releaseTag || snapshot.release_tag || null,
        error: snapshot.error || null,
        stage: nextStage,
        downloading: nextStage === "downloading",
        progressPercent: resetProgress ? 0 : prev.progressPercent,
        downloadedBytes: resetProgress ? 0 : prev.downloadedBytes,
        totalBytes: resetProgress ? 0 : prev.totalBytes,
        actionError: snapshot.needsUpdate ? prev.actionError : null
      };
    });
  }, []);

  const handleUpdateEvent = useCallback(
    (payload) => {
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "state") {
        applyUpdateSnapshot(payload.state);
        return;
      }
      if (payload.type === "progress") {
        setUpdateState((prev) => ({
          ...prev,
          stage: "downloading",
          downloading: true,
          progressPercent:
            typeof payload.percent === "number"
              ? Math.max(0, Math.min(100, payload.percent))
              : prev.progressPercent,
          downloadedBytes:
            typeof payload.downloadedBytes === "number"
              ? payload.downloadedBytes
              : prev.downloadedBytes,
          totalBytes:
            typeof payload.totalBytes === "number"
              ? payload.totalBytes
              : prev.totalBytes
        }));
        return;
      }
      if (payload.type === "status") {
        const status = payload.status;
        if (status === "downloading") {
          setUpdateState((prev) => ({
            ...prev,
            downloading: true,
            stage: "downloading",
            progressPercent: 0,
            downloadedBytes: 0,
            totalBytes: 0,
            actionError: null
          }));
          return;
        }
        if (status === "downloaded") {
          setUpdateState((prev) => ({
            ...prev,
            downloading: false,
            stage: "downloaded",
            progressPercent: 100,
            downloadedBytes:
              typeof payload.downloadedBytes === "number"
                ? payload.downloadedBytes
                : prev.downloadedBytes,
            totalBytes:
              typeof payload.totalBytes === "number"
                ? payload.totalBytes
                : prev.totalBytes
          }));
          return;
        }
        if (status === "restarting") {
          setUpdateState((prev) => ({
            ...prev,
            downloading: false,
            stage: "restarting"
          }));
          return;
        }
        if (status === "error") {
          setUpdateState((prev) => ({
            ...prev,
            downloading: false,
            stage: "error",
            actionError:
              payload.error ||
              prev.actionError ||
              "Не удалось скачать обновление."
          }));
        }
      }
    },
    [applyUpdateSnapshot]
  );

  const handleStartUpdate = useCallback(async () => {
    if (typeof window.launcher?.startUpdateDownload !== "function") return;
    setUpdateState((prev) => ({
      ...prev,
      downloading: true,
      stage: "downloading",
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      actionError: null
    }));
    try {
      const result = await window.launcher.startUpdateDownload();
      if (!result?.ok) {
        throw new Error(result?.error || "Не удалось запустить обновление.");
      }
    } catch (err) {
      setUpdateState((prev) => ({
        ...prev,
        downloading: false,
        stage: "error",
        actionError: err.message || "Не удалось запустить обновление."
      }));
    }
  }, []);

  const handleUpdateRetry = useCallback(async () => {
    if (typeof window.launcher?.refreshUpdate !== "function") return;
    setUpdateState((prev) => ({
      ...prev,
      stage: "pending",
      actionError: null,
      status: "checking"
    }));
    try {
      const info = await window.launcher.refreshUpdate();
      applyUpdateSnapshot(info);
    } catch (err) {
      setUpdateState((prev) => ({
        ...prev,
        stage: "error",
        actionError: err.message || "Не удалось проверить обновления."
      }));
    }
  }, [applyUpdateSnapshot]);

  const getServerDisplayAddress = useCallback((entry) => {
    if (!entry) return "-";
    if (entry.displayAddress) return entry.displayAddress;
    if (entry.address && entry.port) {
      return `${entry.address}:${entry.port}`;
    }
    return entry.address || "-";
  }, []);

  const formatRelativeTime = useCallback((timestamp) => {
    if (!timestamp) return "-";
    const diff = Date.now() - timestamp;
    if (diff < 1500) return "только что";
    if (diff < 60000) return `${Math.floor(diff / 1000)} сек назад`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }, []);

  const formatTps = (tps) => {
    if (typeof tps !== "number" || !Number.isFinite(tps)) return "-";
    const rounded = Math.round(tps * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  };

  const formatLatency = (latency) => {
    if (typeof latency !== "number" || !Number.isFinite(latency)) return "-";
    return `${latency} мс`;
  };

  const formatPlayers = (online, max) => {
    if (typeof online !== "number" || !Number.isFinite(online)) return "-";
    if (typeof max === "number" && Number.isFinite(max) && max > 0) {
      return `${online} / ${max}`;
    }
    return `${online}`;
  };

  const formatBytes = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    const rounded = size >= 100 ? Math.round(size) : Math.round(size * 10) / 10;
    return `${rounded} ${units[index]}`;
  };

  const handleAuthLogin = useCallback(
    async (event) => {
      event.preventDefault();
      if (loginSubmitting) return;

      const trimmedUsername = loginUsername.trim();
      if (!trimmedUsername || !loginPassword) {
        setAuthError("Введите логин и пароль.");
        return;
      }

      if (typeof window.launcher?.authLogin !== "function") {
        setAuthError("Авторизация недоступна в этой сборке.");
        return;
      }

      setAuthError("");
      setLoginSubmitting(true);
      try {
        const result = await window.launcher.authLogin({
          username: trimmedUsername,
          password: loginPassword,
        });
        if (!result?.ok) {
          throw new Error(result?.error || "Не удалось войти.");
        }
        if (result.auth) {
          applyAuthState(result.auth);
          if (result.auth.selectedProfile?.name) {
            setLoginUsername(result.auth.selectedProfile.name);
          }
        }
        setStatus(
          `Выполнен вход как ${
            result?.auth?.selectedProfile?.name || trimmedUsername
          }.`
        );
        setLoginPassword("");
        setShowRegistration(false);
      } catch (err) {
        setAuthError(err.message || "Не удалось войти.");
      } finally {
        setLoginSubmitting(false);
      }
    },
    [loginSubmitting, loginUsername, loginPassword, applyAuthState]
  );

  const handleAuthLogout = useCallback(async () => {
    if (authProcessing) return;
    if (typeof window.launcher?.authLogout !== "function") {
      setAuthError("Завершение сеанса недоступно.");
      return;
    }
    setAuthError("");
    setAuthProcessing(true);
    try {
      const result = await window.launcher.authLogout();
      if (result?.auth) {
        applyAuthState(result.auth);
      }
      setStatus("Вы вышли из аккаунта.");
    } catch (err) {
      setAuthError(err.message || "Не удалось завершить сеанс.");
    } finally {
      setAuthProcessing(false);
    }
  }, [authProcessing, applyAuthState]);

  const handleAuthRefresh = useCallback(async () => {
    if (authProcessing) return;
    if (typeof window.launcher?.authRefresh !== "function") {
      setAuthError("Обновление сессии недоступно.");
      return;
    }
    setAuthError("");
    setAuthProcessing(true);
    try {
      const result = await window.launcher.authRefresh();
      if (!result?.ok) {
        throw new Error(result?.error || "Не удалось обновить сессию.");
      }
      if (result.auth) {
        applyAuthState(result.auth);
      }
      setStatus("Сессия обновлена.");
    } catch (err) {
      setAuthError(err.message || "Не удалось обновить сессию.");
    } finally {
      setAuthProcessing(false);
    }
  }, [authProcessing, applyAuthState]);

  const handleRegisterSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (!auth.allowRegistration || registerSubmitting) return;
      if (typeof window.launcher?.authRegister !== "function") {
        setAuthError("Регистрация недоступна.");
        return;
      }

      const username = registerUsername.trim();
      if (!username || !registerPassword || !registerConfirmPassword) {
        setAuthError("Заполните все поля регистрации.");
        return;
      }
      if (registerPassword !== registerConfirmPassword) {
        setAuthError("Пароли не совпадают.");
        return;
      }

      setAuthError("");
      setRegisterSubmitting(true);
      try {
        const result = await window.launcher.authRegister({
          username,
          password: registerPassword,
          playerName: registerPlayerName.trim() || username,
          inviteCode: registerInviteCode.trim() || undefined,
        });
        if (!result?.ok) {
          throw new Error(result?.error || "Регистрация не удалась.");
        }
        if (result.auth) {
          applyAuthState(result.auth);
          if (result.auth.selectedProfile?.name) {
            setLoginUsername(result.auth.selectedProfile.name);
          }
        }
        setStatus(`Аккаунт ${username} создан и авторизован.`);
        setShowRegistration(false);
        setRegisterPassword("");
        setRegisterConfirmPassword("");
        setRegisterUsername("");
        setRegisterPlayerName("");
        setRegisterInviteCode("");
      } catch (err) {
        setAuthError(err.message || "Регистрация не удалась.");
      } finally {
        setRegisterSubmitting(false);
      }
    },
    [
      auth.allowRegistration,
      registerSubmitting,
      registerUsername,
      registerPassword,
      registerConfirmPassword,
      registerPlayerName,
      registerInviteCode,
      applyAuthState,
    ]
  );

  const handleToggleRegistration = useCallback(() => {
    setAuthError("");
    setShowRegistration((prev) => !prev);
  }, []);

  const authBusy = authProcessing || loginSubmitting || registerSubmitting;

  const refreshServerStatus = useCallback(
    async (server) => {
      if (!server || typeof window.launcher?.fetchServerStatus !== "function") {
        return;
      }

      const serverId = server.id;
      setServerStatuses((prev) => ({
        ...prev,
        [serverId]: {
          ...(prev[serverId] || {}),
          loading: true,
          error: null
        }
      }));

      try {
        const response = await window.launcher.fetchServerStatus(serverId);
        if (!isMountedRef.current) {
          return;
        }
        if (response?.ok) {
          setServerStatuses((prev) => ({
            ...prev,
            [serverId]: {
              loading: false,
              error: null,
              data: response.status,
              server: response.server || server
            }
          }));
        } else {
          setServerStatuses((prev) => ({
            ...prev,
            [serverId]: {
              ...(prev[serverId] || {}),
              loading: false,
              data: response?.status || null,
              server: response?.server || server,
              error: response?.error || "Не удалось получить статус."
            }
          }));
        }
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        setServerStatuses((prev) => ({
          ...prev,
          [serverId]: {
            ...(prev[serverId] || {}),
            loading: false,
            data: null,
            server,
            error: error?.message || "Не удалось получить статус."
          }
        }));
      }
    },
    [setServerStatuses]
  );

  const canFetchServerStatus =
    typeof window.launcher?.fetchServerStatus === "function";

  useEffect(() => {
    (async () => {
      try {
        const bootstrap = await window.launcher.bootstrap();
        const settings = bootstrap.settings || {};
        setModpacks(bootstrap.modpacks || []);
        setActiveModpackId(bootstrap.activeModpackId || null);
        setPaths(bootstrap.paths || {});
        setServers(
          Array.isArray(bootstrap.servers) ? bootstrap.servers : []
        );
        setServerStatuses({});
        setDefaults(
          bootstrap.defaults || { ramMb: 2048, minRamMb: 1024 }
        );
        setTheme(bootstrap.theme || {});
        applySettings(settings);
        if (bootstrap.gameOptions) {
          syncGameOptionsState(bootstrap.gameOptions);
        } else {
          syncGameOptionsState(DEFAULT_GAME_OPTIONS_STATE);
        }
        applyAuthState(bootstrap.auth || settings.auth || null);
        if (bootstrap.update) {
          applyUpdateSnapshot(bootstrap.update);
        } else {
          applyUpdateSnapshot({
            enabled: false,
            status: "disabled",
            needsUpdate: false
          });
        }
        const initialLoginName =
          bootstrap.auth?.selectedProfile?.name ||
          bootstrap.auth?.user?.username ||
          settings.nickname ||
          "";
        setLoginUsername(initialLoginName || "");
        setAuthError("");
        setShowRegistration(false);
        setStatus("Лаунчер готов!");
        setBootstrapped(true);
        readyRef.current = true;
      } catch (err) {
        console.error(err);
        setStatus("Ошибка инициализации: " + err.message);
      }
    })();
  }, [applyUpdateSnapshot]);

  useEffect(() => {
    window.launcher.onLog((msg) => {
      setLogs((prev) => {
        const next = [...prev, msg];
        return next.slice(-500);
      });
    });
    window.launcher.onProgress((payload) => {
      setProgress(payload);
    });
  }, []);

  useEffect(() => {
    if (typeof window.launcher?.onUpdate !== "function") return;
    const dispose = window.launcher.onUpdate(handleUpdateEvent);
    return () => {
      if (typeof dispose === "function") {
        dispose();
      }
    };
  }, [handleUpdateEvent]);

  useEffect(() => {
    Object.values(serverTimersRef.current || {}).forEach((timer) =>
      clearInterval(timer)
    );
    serverTimersRef.current = {};

    if (
      !servers.length ||
      typeof window.launcher?.fetchServerStatus !== "function"
    ) {
      return;
    }

    const timers = {};
    servers.forEach((server) => {
      const interval = Math.max(
        MIN_SERVER_REFRESH_MS,
        Number(server.refreshIntervalMs) || 60000
      );
      const run = () => refreshServerStatus(server);
      run();
      timers[server.id] = setInterval(run, interval);
    });

    serverTimersRef.current = timers;

    return () => {
      Object.values(timers).forEach((timer) => clearInterval(timer));
    };
  }, [servers, refreshServerStatus]);

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    if (!readyRef.current) return;
    if (skipSettingsSync.current) {
      skipSettingsSync.current = false;
      return;
    }
    const handle = setTimeout(() => {
      window.launcher
        .updateSettings({
          nickname,
          ramMb: Number(ram),
        })
        .catch((err) => console.error(err));
    }, 400);
    return () => clearTimeout(handle);
  }, [nickname, ram]);

const activeModpack = useMemo(
  () => modpacks.find((pack) => pack.id === activeModpackId) || null,
  [modpacks, activeModpackId]
);

  const greeting = useMemo(() => getTimeGreeting(), []);
  const bannerSubtitle = useMemo(() => {
    if (activeModpack) {
      return `Готовы к приключениям в сборке "${activeModpack.name}"? Мы уже все подготовили.`;
    }
    if (modpacks.length) {
      return `Выберите одну из ${modpacks.length} готовых сборок или синхронизируйте новые.`;
    }
    return "Нажмите «Синхронизировать моды», чтобы загрузить первую сборку.";
  }, [activeModpack, modpacks.length]);

  const profileSummary = useMemo(() => {
    return `Текущие настройки: ник ${nickname}, память ${ram} МБ`;
  }, [nickname, ram]);

  const bannerVisuals = useMemo(() => {
    const baseProfile = {
      id: nickname || "virtual-user",
      label: "Игрок",
      nickname: nickname || "Игрок",
    };
    return getProfileVisuals(baseProfile);
  }, [nickname]);

  const serversLoading = useMemo(
    () =>
      servers.some((server) => serverStatuses[server.id]?.loading),
    [servers, serverStatuses]
  );

  const handleServerStatusRefresh = useCallback(() => {
    servers.forEach((server) => refreshServerStatus(server));
  }, [servers, refreshServerStatus]);

  const handleRamInput = (value) => {
    setRam(value);
  };

  const commitRamValue = () => {
    const numeric = Number(ram);
    if (!Number.isFinite(numeric)) {
      setRam(defaults.ramMb);
      return;
    }
    const clamped = clamp(
      Math.round(numeric),
      defaults.minRamMb || 1024,
      65536
    );
    setRam(clamped);
  };




  const handleSyncMods = async () => {
    try {
      setSyncing(true);
      setStatus("Синхронизируем моды...");
      const res = await window.launcher.syncMods();
      if (res.ok) {
        setStatus(`Готово! Скопировано файлов: ${res.copied || 0}.`);
      } else {
        setStatus("Не удалось синхронизировать моды: " + res.error);
      }
    } catch (err) {
      setStatus("Не удалось синхронизировать моды: " + err.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleOpenMods = async () => {
    try {
      await window.launcher.openModsFolder(activeModpackId);
      setStatus("Открываем папку с модами. Настраивайте игру под себя!");
    } catch (err) {
      setStatus("Не удалось открыть папку модов: " + err.message);
    }
  };

  const handleDownloadShaderpacks = async () => {
    try {
      setDownloadingShaders(true);
      setStatus("Downloading shader packs...");
      const res = await window.launcher.downloadShaderpacks();
      if (res?.ok) {
        const count = res.copiedCount ?? (Array.isArray(res.copied) ? res.copied.length : 0);
        setStatus(`Shader packs ready. Updated files: ${count}.`);
      } else {
        setStatus("Failed to download shader packs: " + (res?.error || "Unknown error"));
      }
    } catch (err) {
      setStatus("Failed to download shader packs: " + err.message);
    } finally {
      setDownloadingShaders(false);
    }
  };

  const handleDownloadResourcepacks = async () => {
    try {
      setDownloadingResources(true);
      setStatus("Downloading resource packs...");
      const res = await window.launcher.downloadResourcepacks();
      if (res?.ok) {
        const count = res.copiedCount ?? (Array.isArray(res.copied) ? res.copied.length : 0);
        setStatus(`Resource packs ready. Updated files: ${count}.`);
      } else {
        setStatus("Failed to download resource packs: " + (res?.error || "Unknown error"));
      }
    } catch (err) {
      setStatus("Failed to download resource packs: " + err.message);
    } finally {
      setDownloadingResources(false);
    }
  };

  const handlePlay = async () => {
    if (syncing || downloadingShaders || downloadingResources || launching) {
      return;
    }

    const ensureOk = (response, fallback) => {
      if (response && response.ok === false) {
        throw new Error(response.error || fallback);
      }
    };

    try {
      setStatus("Проверяем сборку...");
      setSyncing(true);
      const syncResult = await window.launcher.syncMods();
      setSyncing(false);
      ensureOk(syncResult, "не удалось синхронизировать моды");
      const syncedCount = syncResult?.copied ?? syncResult?.updated ?? 0;
      setStatus(
        syncedCount
          ? `Сборка обновлена. Изменено файлов: ${syncedCount}.`
          : "Сборка уже актуальна."
      );

      if (window.launcher?.downloadShaderpacks) {
        setStatus("Обновляем шейдеры...");
        setDownloadingShaders(true);
        const shaderResult = await window.launcher.downloadShaderpacks();
        setDownloadingShaders(false);
        ensureOk(shaderResult, "не удалось обновить шейдеры");
        const shaderCount =
          shaderResult?.copiedCount ??
          (Array.isArray(shaderResult?.copied) ? shaderResult.copied.length : 0);
        setStatus(
          shaderCount
            ? `Шейдеры обновлены (${shaderCount}).`
            : "Шейдеры уже актуальны."
        );
      }

      if (window.launcher?.downloadResourcepacks) {
        setStatus("Обновляем ресурспаки...");
        setDownloadingResources(true);
        const resourceResult = await window.launcher.downloadResourcepacks();
        setDownloadingResources(false);
        ensureOk(resourceResult, "не удалось обновить ресурспаки");
        const resourcesCount =
          resourceResult?.copiedCount ??
          (Array.isArray(resourceResult?.copied) ? resourceResult.copied.length : 0);
        setStatus(
          resourcesCount
            ? `Ресурспаки обновлены (${resourcesCount}).`
            : "Ресурспаки уже актуальны."
        );
      }

      setStatus("Запускаем Minecraft...");
      setLaunching(true);
      const launchResult = await window.launcher.launch({
        username: nickname,
        ramMb: Number(ram),
      });
      setLaunching(false);
      ensureOk(launchResult, "не удалось запустить Minecraft");
      setStatus("Minecraft запущен. Приятной игры!");
    } catch (error) {
      setSyncing(false);
      setDownloadingShaders(false);
      setDownloadingResources(false);
      setLaunching(false);
      setStatus("Не удалось подготовить запуск: " + (error?.message || String(error)));
    }
  };

  const handleModpackSelect = async (modpack) => {
    if (!modpack || modpack.id === activeModpackId) return;
    try {
      setStatus(`Переключаемся на сборку "${modpack.name}"...`);
      const result = await window.launcher.selectModpack(modpack.id);
      setActiveModpackId(result.activeModpackId);
      setPaths(result.paths || {});
      if (result.settings) {
        applySettings(result.settings);
      }
      if (result.gameOptions) {
        syncGameOptionsState(result.gameOptions);
      } else {
        syncGameOptionsState(DEFAULT_GAME_OPTIONS_STATE);
      }
      setStatus(`Сборка "${modpack.name}" готова.`);
    } catch (err) {
      setStatus("Не удалось активировать сборку: " + err.message);
    }
  };

  const playBusy = syncing || downloadingShaders || downloadingResources || launching;

  const progressPercent =
    progress && progress.task && progress.task.total
      ? Math.round((progress.task.progress / progress.task.total) * 100)
      : 0;

  const updatePercent = Math.max(
    0,
    Math.min(
      100,
      typeof updateState.progressPercent === "number"
        ? updateState.progressPercent
        : 0
    )
  );
  const downloadedText = formatBytes(updateState.downloadedBytes);
  const totalText = formatBytes(updateState.totalBytes);
  const shouldShowUpdateOverlay =
    updateState.enabled &&
    (updateState.needsUpdate ||
      updateState.stage === "downloading" ||
      updateState.stage === "downloaded" ||
      updateState.stage === "restarting" ||
      updateState.stage === "error");
  const updateButtonDisabled =
    updateState.downloading || updateState.stage === "restarting";
  const showRetryButton =
    !updateState.downloading &&
    (updateState.stage === "error" || updateState.status === "error");
  let updateStatusText = "Доступна новая версия лаунчера.";
  if (updateState.stage === "downloading") {
    updateStatusText = "Скачиваем обновление...";
  } else if (updateState.stage === "downloaded") {
    updateStatusText = "Загрузка завершена. Подготовка к установке.";
  } else if (updateState.stage === "restarting") {
    updateStatusText =
      "Перезапускаем лаунчер, чтобы завершить установку.";
  } else if (updateState.stage === "error") {
    updateStatusText =
      updateState.actionError ||
      "Не удалось скачать обновление. Попробуйте еще раз.";
  } else if (updateState.status === "error") {
    updateStatusText =
      updateState.error ||
      "Не удалось проверить обновления -_- \n Повторите попытку.";
  }

  return (
    <div className="app-shell">
      {!bootstrapped && (
        <div className="loading-overlay">
          <div className="spinner" />
          <p>Готовим лаунчер…</p>
        </div>
      )}

      {shouldShowUpdateOverlay && (
        <div className="update-overlay">
          <div className="update-panel">
            <h2>Обновись на новую версию</h2>
            <p>
              Доступна новая версия лаунчера.
              {updateState.currentVersion && updateState.latestVersion
                ? ` Сейчас установлена ${updateState.currentVersion}, новая версия — ${updateState.latestVersion}.`
                : ""}
            </p>
            <div className="update-meta">
              {updateState.currentVersion && (
                <span>
                  Текущая версия:{" "}
                  <strong>{updateState.currentVersion}</strong>
                </span>
              )}
              {updateState.latestVersion && (
                <span>
                  Новая версия:{" "}
                  <strong>{updateState.latestVersion}</strong>
                </span>
              )}
            </div>
            <p>{updateStatusText}</p>
            {(updateState.stage === "downloading" ||
              updateState.stage === "downloaded") && (
              <div className="update-progress">
                <div className="update-progress-bar">
                  <div
                    className="update-progress-fill"
                    style={{ width: `${updatePercent}%` }}
                  />
                </div>
                <span>
                  {updatePercent}%
                  {downloadedText ? ` - ${downloadedText}` : ""}
                  {totalText ? ` / ${totalText}` : ""}
                </span>
              </div>
            )}
            {updateState.stage === "error" && updateState.actionError && (
              <div className="update-error">{updateState.actionError}</div>
            )}
            {updateState.releaseNotes &&
              updateState.releaseNotes.trim() && (
                <div className="update-notes">
                  {updateState.releaseNotes}
                </div>
              )}
            <div className="update-actions">
              <button
                type="button"
                onClick={handleStartUpdate}
                disabled={updateButtonDisabled}
              >
                {updateState.stage === "downloading"
                  ? "Загрузка..."
                  : updateState.stage === "restarting"
                  ? "Перезапуск..."
                  : "Обновить"}
              </button>
              {showRetryButton && (
                <button
                  type="button"
                  className="secondary"
                  onClick={handleUpdateRetry}
                >
                  Повторить проверку
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-accent">Custom</span>
          <span>Launcher</span>
          <span className="brand-sub">Minecraft Edition</span>
        </div>
        <div className="sidebar-section auth-section">
          <div className="sidebar-header">
            <h2>Account</h2>
          </div>
          <div className={`auth-card${auth.status === "authenticated" ? " authenticated" : ""}`}>
            {auth.status === "authenticated" ? (
              <div className="auth-summary">
                <div className="auth-identity">
                  <span className="auth-name">
                    {auth.selectedProfile?.name ||
                      auth.user?.username ||
                      loginUsername ||
                      "Player"}
                  </span>
                  {auth.status === "authenticated" && (
                    <span className="auth-base">Authorized ^_^</span>
                  )}
                </div>
                <div className="auth-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={handleAuthRefresh}
                    disabled={authBusy}
                  >
                    {authBusy ? "Refreshing..." : "Refresh"}
                  </button>
                  <button
                    type="button"
                    className="ghost-button danger"
                    onClick={handleAuthLogout}
                    disabled={authBusy}
                  >
                    Sign out
                  </button>
                </div>
              </div>
            ) : auth.status === "disabled" ? (
              <div className="auth-disabled">
                <p>Authentication server is not configured.</p>
              </div>
            ) : (
              <form className="auth-form" onSubmit={handleAuthLogin}>
                <label>
                  <span>Username</span>
                  <input
                    value={loginUsername}
                    onChange={(event) => setLoginUsername(event.target.value)}
                    autoComplete="username"
                    placeholder="Your nickname"
                    disabled={authBusy}
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(event) => setLoginPassword(event.target.value)}
                    autoComplete="current-password"
                    placeholder="Password"
                    disabled={authBusy}
                  />
                </label>
                <div className="auth-actions">
                  <button type="submit" className="primary" disabled={authBusy}>
                    {loginSubmitting ? "Signing in..." : "Sign in"}
                  </button>
                  {auth.allowRegistration && (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={handleToggleRegistration}
                      disabled={authBusy}
                    >
                      {showRegistration ? "Cancel" : "Create account"}
                    </button>
                  )}
                </div>
              </form>
            )}
            {showRegistration &&
              auth.allowRegistration &&
              auth.status !== "authenticated" && (
                <form
                  className="auth-form registration"
                  onSubmit={handleRegisterSubmit}
                >
                  <label>
                    <span>Username</span>
                    <input
                      value={registerUsername}
                      onChange={(event) =>
                        setRegisterUsername(event.target.value)
                      }
                      placeholder="New username"
                      disabled={authBusy}
                    />
                  </label>
                  <label>
                    <span>Password</span>
                    <input
                      type="password"
                      value={registerPassword}
                      onChange={(event) =>
                        setRegisterPassword(event.target.value)
                      }
                      placeholder="Password"
                      disabled={authBusy}
                    />
                  </label>
                  <label>
                    <span>Confirm password</span>
                    <input
                      type="password"
                      value={registerConfirmPassword}
                      onChange={(event) =>
                        setRegisterConfirmPassword(event.target.value)
                      }
                      placeholder="Repeat password"
                      disabled={authBusy}
                    />
                  </label>
                  <label>
                    <span>Player name</span>
                    <input
                      value={registerPlayerName}
                      onChange={(event) =>
                        setRegisterPlayerName(event.target.value)
                      }
                      placeholder="In-game nickname"
                      disabled={authBusy}
                    />
                  </label>
                  <label>
                    <span>Invite code (optional)</span>
                    <input
                      value={registerInviteCode}
                      onChange={(event) =>
                        setRegisterInviteCode(event.target.value)
                      }
                      placeholder="Invite code"
                      disabled={authBusy}
                    />
                  </label>
                  <div className="auth-actions">
                    <button
                      type="submit"
                      className="primary"
                      disabled={authBusy}
                    >
                      {registerSubmitting ? "Creating..." : "Create account"}
                    </button>
                  </div>
                </form>
              )}
            {authError && (
              <div className="auth-error">{authError}</div>
            )}
          </div>
        </div>
        <div className="sidebar-section highlight">
          <div className="sidebar-header">
            <h2>Сборки</h2>
          </div>
          <div className="modpack-grid">
            {modpacks.map((pack) => {
              const isActive = pack.id === activeModpackId;
              return (
                <button
                  key={pack.id}
                  className={`modpack-tile${isActive ? " active" : ""}`}
                  onClick={() => handleModpackSelect(pack)}
                >
                  {pack.icon ? (
                    <img src={pack.icon} alt={pack.name} />
                  ) : (
                    <div className="modpack-placeholder">
                      <span>{pack.name.slice(0, 1).toUpperCase()}</span>
                    </div>
                  )}
                  <div className="modpack-meta">
                    <div className="title">{pack.name}</div>
                    <div className="subtitle">
                      {pack.description || "Описание появится позже"}
                    </div>
                  </div>
                  <span className="modpack-pill" aria-hidden="true" />
                </button>
              );
            })}
            {!modpacks.length && (
              <div className="empty-state">
                Сборки не найдены. Добавьте конфигурацию в конфиг.
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="main-area">
        <AmbientBackground
          imageSrc={normalizedTheme.backgroundImage}
          glassTint={normalizedTheme.glassTint}
          glassOpacity={normalizedTheme.glassOpacity}
          blurRadius={normalizedTheme.blurRadius}
          fireflyConfig={normalizedTheme.firefly}
        />
        <div className="main-area-content">
          <section
          className="user-banner"
          style={{ "--banner-glow": phaseVisual.glow }}
        >
          <div
            className="user-banner-avatar"
            style={{ background: bannerVisuals.gradient }}
          >
            <span className="user-banner-icon" aria-hidden="true">
              {bannerVisuals.glyph || bannerVisuals.initial}
            </span>
          </div>
          <div className="user-banner-content">
            <p className="user-greeting">
              {greeting}, {nickname || "Игрок"}!
            </p>
            <div className="user-banner-footer">
              <span>{profileSummary}</span>
            </div>
          </div>
          <div
            className="user-banner-moment"
            style={{
              background: phaseVisual.cardBackground,
              borderColor: phaseVisual.cardBorder,
              boxShadow: phaseVisual.cardShadow,
              "--moment-icon-color": phaseVisual.iconColor,
            }}
          >
            <span className="user-banner-moment-icon">
              <MomentIcon />
            </span>
            <span className="user-banner-moment-label">
              <span className="user-banner-moment-clock">{timeDisplay}</span>
              <span className="user-banner-moment-sub">
                <span className="user-banner-moment-name">{phaseVisual.label}</span>
                <span className="user-banner-moment-time">{phaseVisual.hint}</span>
              </span>
            </span>
          </div>
        </section>
        <header className="main-header">
          <div>
            <h1>
              {activeModpack ? activeModpack.name : "Minecraft Launcher"}
            </h1>
            <p className="subtitle">
              {activeModpack
                ? activeModpack.description || "Forge 1.12.2"
                : "Forge 1.12.2"}
            </p>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="icon-button settings-trigger"
              onClick={() => setSettingsOpen(true)}
              aria-label="Открыть настройки"
              title="Открыть настройки"
            >
            Настройки
            </button>
          </div>
        </header>
        <section className="card action-flow" id="quick-start">
          <div className="flow-header">
            <div className="flow-title">
              <span className="flow-badge">Быстрый старт</span>
              <p className="subtitle">Кнопка «Играть» возьмёт на себя подготовку сборки перед стартом.</p>
            </div>
          </div>
          <div className="flow-track">
            <article className="flow-card flow-card--launch" id="step-launch">
              <div className="flow-card-head">
                <span className="flow-icon flow-icon--launch" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="8" />
                    <path d="M10 9.5l6 3.5-6 3.5z" />
                  </svg>
                </span>
                <div>
                  <h3>Запускай игру</h3>
                </div>
              </div>
              <div className="flow-actions">
                <button
                  className="primary flow-button"
                  onClick={handlePlay}
                  disabled={playBusy}
                >
                  {playBusy ? "Готовим к запуску..." : "Играть"}
                </button>
                <p className="flow-status">{status}</p>
              </div>
              {progress && progressPercent > 0 && (
                <div className="flow-progress">
                  <div className="progress">
                    <div
                      className="progress-bar"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <span className="progress-text">
                    {progressPercent}% -{" "}
                    {progress.type || "Подготовка окружения"}
                  </span>
                </div>
              )}
            </article>
          </div>
        </section>


        {servers.length > 0 && (
          <section className="card server-card">
            <div className="server-card-header">
              <div>
                <h2>Статус сервера</h2>
                <p className="subtitle">
                  Онлайн, TPS и пинг вашего сервера в реальном времени.
                </p>
              </div>
              {canFetchServerStatus ? (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleServerStatusRefresh}
                  disabled={serversLoading}
                >
                  {serversLoading ? "Обновляем..." : "Обновить"}
                </button>
              ) : (
                <span className="server-card-hint">
                  Обновление недоступно в этой сборке
                </span>
              )}
            </div>

            {!canFetchServerStatus && (
              <p className="server-status-hint">
                Добавьте поддержку обновления статуса в preload, чтобы
                включить автоматическое обновление.
              </p>
            )}

            <div className="server-status-list">
              {servers.map((server) => {
                const entry = serverStatuses[server.id] || {};
                const data = entry.data;
                const icon = data?.icon;
                const serverInfo = entry.server || server;
                const name = serverInfo?.name || server.name;
                const displayAddress = getServerDisplayAddress(serverInfo);
                const online = Boolean(data?.online);
                const playersOnline =
                  typeof data?.playersOnline === "number"
                    ? data.playersOnline
                    : null;
                const playersMax =
                  typeof data?.playersMax === "number"
                    ? data.playersMax
                    : null;
                const latency = data?.latencyMs;
                const tps = data?.tps;
                const lastUpdated = data?.fetchedAt;
                const error = entry.error;
                const loading = entry.loading;
                const fallbackGradient =
                  PROFILE_GRADIENTS[
                    sumCharCodes(server.id || server.address) %
                      PROFILE_GRADIENTS.length
                  ];
                const initial =
                  (
                    (name || displayAddress || "S").trim().charAt(0) || "S"
                  ).toUpperCase();

                return (
                  <article className="server-status-entry" key={server.id}>
                    <div
                      className="server-status-avatar"
                      style={{ background: fallbackGradient }}
                    >
                      {icon ? (
                        <img src={icon} alt={`${name} icon`} />
                      ) : (
                        <span>{initial}</span>
                      )}
                    </div>
                    <div className="server-status-body">
                      <div className="server-status-header">
                        <div className="server-status-title">
                          <span
                            className={`status-dot ${
                              online ? "online" : "offline"
                            }`}
                            aria-hidden="true"
                          />
                          <span>{name}</span>
                        </div>
                        <span className="server-status-updated">
                          {loading
                            ? "Обновляем..."
                            : data
                            ? `Обновлено ${formatRelativeTime(lastUpdated)}`
                            : canFetchServerStatus
                            ? "Ожидаем данные"
                            : "Недоступно"}
                        </span>
                      </div>
                      <div className="server-status-address">
                        IP: <code>{displayAddress}</code>
                      </div>
                      <div className="server-status-meta">
                        <div>
                          <span className="meta-label">Статус</span>
                          <span
                            className={`meta-value ${
                              online ? "online" : "offline"
                            }`}
                          >
                            {online ? "Онлайн" : "Оффлайн"}
                          </span>
                        </div>
                        <div>
                          <span className="meta-label">Игроки</span>
                          <span className="meta-value">
                            {formatPlayers(playersOnline, playersMax)}
                          </span>
                        </div>
                        <div>
                          <span className="meta-label">TPS</span>
                          <span className="meta-value">
                            {online ? formatTps(tps) : "-"}
                          </span>
                        </div>
                        <div>
                          <span className="meta-label">Пинг</span>
                          <span className="meta-value">
                            {online ? formatLatency(latency) : "-"}
                          </span>
                        </div>
                      </div>
                      {data?.motd && (
                        <p className="server-motd">{data.motd}</p>
                      )}
                      {error && !loading && (
                        <p className="server-status-error">{error}</p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}



        </div>
      </main>
      {settingsOpen && (
        <div
          className="settings-overlay"
          role="presentation"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="settings-header">
              <div>
                <span className="settings-tag">Настройки</span>
                <h2 id="settings-title">Профиль и память</h2>
                <p className="settings-subtitle">
                  Выбирайте ник и объём оперативной памяти Рґля выбранной сборки.
                </p>
              </div>
              <button
                type="button"
                className="icon-button settings-close"
                onClick={() => setSettingsOpen(false)}
                aria-label="Закрыть настройки"
                title="Закрыть настройки"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>
            <div className="settings-fields">
              <label>
                RAM (MB)
                <input
                  key="ram-input"
                  type="number"
                  value={ram}
                  min={defaults.minRamMb || 1024}
                  max={65536}
                  step="256"
                  onChange={(e) => handleRamInput(e.target.value)}
                  onBlur={commitRamValue}
                />
                <span className="hint">
                  Минимум {defaults.minRamMb || 1024} МБ. Рекомендуемо от {Math.max(defaults.ramMb, defaults.minRamMb)} МБ.
                </span>
              </label>


              <div className="settings-card">
                <div className="settings-card-head">
                  <div>
                    <span className="settings-card-title">FPS и плавность</span>
                    <p className="settings-card-subtitle">
                      Управляйте V-Sync и ограничением FPS прямо из лаунчера перед запуском.
                    </p>
                  </div>
                </div>
                <div
                  className="fps-mode-toggle"
                  role="group"
                  aria-label="Режим частоты кадров"
                >
                  <button
                    type="button"
                    aria-pressed={fpsMode === "vsync"}
                    className={fpsMode === "vsync" ? "active" : ""}
                    onClick={() => handleFpsModeChange("vsync")}
                  >
                    V-Sync
                  </button>
                  <button
                    type="button"
                    aria-pressed={fpsMode === "limit"}
                    className={fpsMode === "limit" ? "active" : ""}
                    onClick={() => handleFpsModeChange("limit")}
                  >
                    Лимит FPS
                  </button>
                  <button
                    type="button"
                    aria-pressed={fpsMode === "unlimited"}
                    className={fpsMode === "unlimited" ? "active" : ""}
                    onClick={() => handleFpsModeChange("unlimited")}
                  >
                    Без лимита
                  </button>
                </div>
                <div className="fps-limit-input">
                  <input
                    id="fps-limit-input"
                    type="number"
                    min={FPS_LIMIT_MIN}
                    max={FPS_LIMIT_MAX}
                    step="5"
                    value={fpsInput}
                    onChange={(event) =>
                      handleFpsInputChange(event.target.value)
                    }
                    onBlur={commitFpsInput}
                    onKeyDown={handleFpsInputKeyDown}
                  />
                  <span className="hint">
                    Введите любое значение от {FPS_LIMIT_MIN} до {FPS_LIMIT_MAX} FPS.
                    При вводе режим «Лимит FPS» выбирается автоматически.
                  </span>
                </div>
                <div className="settings-meta">
                  <span className="settings-pill">Выбрано: {fpsSummary}</span>
                  <span className="settings-pill">
                    Текущее значение: {fpsInput || String(gameOptions.fpsLimit)} FPS
                  </span>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-head">
                  <div>
                    <span className="settings-card-title">Язык клиента</span>
                    <p className="settings-card-subtitle">
                      Введите официальный код Mojang (ru_ru, en_us, uk_ua и т.д.).
                    </p>
                  </div>
                </div>
                <div className="language-input">
                  <input
                    type="text"
                    value={languageInput}
                    placeholder="ru_ru"
                    list="game-language-options"
                    onChange={(event) =>
                      handleLanguageInputChange(event.target.value)
                    }
                    onBlur={handleLanguageBlur}
                  />
                  <span className="hint">
                    Код автоматически синхронизируется с options.txt и optionsof.txt.
                  </span>
                  <datalist id="game-language-options">
                    {LANGUAGE_PRESETS.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.label}
                      </option>
                    ))}
                  </datalist>
                </div>
                <div className="settings-meta">
                  <span className="settings-pill">Текущий код: {languageSummary}</span>
                </div>
              </div>
              <div
                className={`game-options-status ${
                  gameOptionsSaving ? "saving" : ""
                }`}
              >
                <span>{gameOptionsStatusText}</span>
              </div>
              {gameOptionsError && (
                <p className="settings-error">{gameOptionsError}</p>
              )}
            </div>
            <p className="settings-hint">
              Совет: параметры профиля и игры сохраняются автоматически после синхронизации сборки.
            </p>
          </div>
        </div>
      )}

  </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

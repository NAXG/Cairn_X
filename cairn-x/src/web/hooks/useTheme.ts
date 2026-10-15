import { useCallback, useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "auto" | "mist" | "rose" | "pine";
type ResolvedTheme = "light" | "dark";
/** 实际写入 `html[data-theme]` 的主题名；`auto` 解析为 light / dark。 */
type AppliedTheme = "light" | "dark" | "mist" | "rose" | "pine";

type ThemeState = {
	preference: ThemePreference;
	theme: ResolvedTheme;
	applied: AppliedTheme;
};

const STORAGE_KEY = "cairn-theme";
const PREFERENCE_CYCLE: ThemePreference[] = ["light", "dark", "mist", "rose", "pine", "auto"];
const listeners = new Set<() => void>();
let state: ThemeState | null = null;
let systemListening = false;

function emit(): void {
	listeners.forEach((cb) => cb());
}

function getSystemTheme(): ResolvedTheme {
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredPreference(): ThemePreference {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		if (
			value === "light" ||
			value === "dark" ||
			value === "auto" ||
			value === "mist" ||
			value === "rose" ||
			value === "pine"
		)
			return value;
	} catch {
		// ignore storage errors (private mode, quota, etc.)
	}
	return "auto";
}

function appliedTheme(preference: ThemePreference): AppliedTheme {
	return preference === "auto" ? getSystemTheme() : preference;
}

function resolveTheme(applied: AppliedTheme): ResolvedTheme {
	return applied === "light" || applied === "mist" || applied === "rose" ? "light" : "dark";
}

function applyDomTheme(applied: AppliedTheme): void {
	const root = document.documentElement;
	root.dataset.theme = applied;
	root.classList.toggle("dark", resolveTheme(applied) === "dark");
}

function ensureState(): ThemeState {
	if (state) return state;

	const preference = readStoredPreference();
	const applied = appliedTheme(preference);
	applyDomTheme(applied);
	state = { preference, theme: resolveTheme(applied), applied };
	return state;
}

function setThemeState(preference: ThemePreference, persist: boolean): void {
	const applied = appliedTheme(preference);
	applyDomTheme(applied);
	if (persist) {
		try {
			localStorage.setItem(STORAGE_KEY, preference);
		} catch {
			// ignore storage errors (private mode, quota, etc.)
		}
	}
	state = { preference, theme: resolveTheme(applied), applied };
	emit();
}

function syncAutoThemeFromSystem(): void {
	const current = ensureState();
	if (current.preference !== "auto") return;
	if (getSystemTheme() === current.applied) return;
	setThemeState("auto", false);
}

function ensureSystemListener(): void {
	if (systemListening) return;

	const mql = window.matchMedia("(prefers-color-scheme: dark)");
	mql.addEventListener("change", syncAutoThemeFromSystem);
	// Some browsers delay or miss scheme events while backgrounded.
	window.addEventListener("focus", syncAutoThemeFromSystem);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") syncAutoThemeFromSystem();
	});
	systemListening = true;
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	ensureState();
	ensureSystemListener();
	syncAutoThemeFromSystem();
	return () => {
		listeners.delete(cb);
	};
}

function getSnapshot(): ThemeState {
	return ensureState();
}

function nextPreference(preference: ThemePreference): ThemePreference {
	const index = PREFERENCE_CYCLE.indexOf(preference);
	return PREFERENCE_CYCLE[(index + 1) % PREFERENCE_CYCLE.length];
}

export function useTheme() {
	const snapshot = useSyncExternalStore(subscribe, getSnapshot);

	const setThemePreference = useCallback((nextPreference: ThemePreference) => {
		const current = ensureState();
		if (current.preference === nextPreference) return;

		const apply = () => {
			setThemeState(nextPreference, true);
		};

		const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const supportsVT = typeof document.startViewTransition === "function";

		if (!supportsVT || reduceMotion) {
			apply();
			return;
		}

		const x = window.innerWidth / 2;
		const y = window.innerHeight / 2;
		const endRadius = Math.hypot(
			Math.max(x, window.innerWidth - x),
			Math.max(y, window.innerHeight - y),
		);

		const transition = document.startViewTransition(apply);
		transition.ready
			.then(() => {
				document.documentElement.animate(
					{
						clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`],
					},
					{
						duration: 450,
						easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
						pseudoElement: "::view-transition-new(root)",
					},
				);
			})
			.catch(() => {
				// transition cancelled — ignore
			});
	}, []);

	const toggleTheme = useCallback(() => {
		const current = ensureState();
		setThemePreference(nextPreference(current.preference));
	}, [setThemePreference]);

	return {
		theme: snapshot.theme,
		applied: snapshot.applied,
		preference: snapshot.preference,
		setThemePreference,
		toggleTheme,
	};
}

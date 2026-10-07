import { describe, it, expect, afterEach } from "vitest";
import {
  chromiumCandidates,
  detectSystemBrowsers,
  profilesFromLocalState,
  cookieMatchesDomains,
  toCookieParam,
  parseDevToolsActivePort,
  resolveEgoStateDir,
  listLoginSources,
  importLoginCookies,
} from "../src/login-import.ts";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawn as cpSpawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("chromiumCandidates / detectSystemBrowsers", () => {
  it("builds Windows candidate paths from env", () => {
    const c = chromiumCandidates(
      { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
      "win32",
    );
    expect(c.length).toBeGreaterThanOrEqual(5);
    expect(c[0].exePath).toContain("chrome.exe");
    expect(c[0].userDataDir).toBe("C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data");
    expect(c.some((b) => b.id === "edge")).toBe(true);
  });

  it("builds Linux candidate paths", () => {
    const c = chromiumCandidates({ HOME: "/home/u" }, "linux");
    expect(c[0].exePath).toBe("/usr/bin/google-chrome");
    expect(c[0].userDataDir).toBe("/home/u/.config/google-chrome");
  });

  it("detectSystemBrowsers filters out nonexistent installs", () => {
    // No fabricated env paths exist on disk → empty.
    const env = {
      LOCALAPPDATA: "Z:\\definitely\\not\\here",
      ProgramFiles: "Z:\\nope",
      "ProgramFiles(x86)": "Z:\\nope2",
    };
    expect(detectSystemBrowsers(env, "win32")).toEqual([]);
  });
});

describe("profilesFromLocalState", () => {
  it("reads profile.info_cache into dir/name pairs", () => {
    const json = JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Person 1" },
          "Profile 1": { name: "Work" },
        },
      },
    });
    const profiles = profilesFromLocalState(json, "C:\\UD");
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toEqual({ dir: "C:\\UD\\Default", dirName: "Default", name: "Person 1" });
    expect(profiles[1].name).toBe("Work");
  });

  it("falls back to Default on garbage input", () => {
    const p = profilesFromLocalState("not json", "/ud");
    expect(p).toHaveLength(1);
    expect(p[0].dirName).toBe("Default");
    expect(p[0].name).toBe("Default");
  });

  it("falls back to Default when info_cache is empty", () => {
    expect(profilesFromLocalState("{}", "/ud")[0].dirName).toBe("Default");
  });
});

describe("cookieMatchesDomains", () => {
  it("matches exact and subdomain, case-insensitive, leading-dot tolerant", () => {
    expect(cookieMatchesDomains(".bilibili.com", ["bilibili.com"])).toBe(true);
    expect(cookieMatchesDomains("api.bilibili.com", ["Bilibili.com"])).toBe(true);
    expect(cookieMatchesDomains("bilibili.com", [".bilibili.com"])).toBe(true);
  });

  it("rejects unrelated and sibling domains", () => {
    expect(cookieMatchesDomains("notbilibili.com", ["bilibili.com"])).toBe(false);
    expect(cookieMatchesDomains("bilibili.com.evil.cn", ["bilibili.com"])).toBe(false);
    expect(cookieMatchesDomains("zhihu.com", ["bilibili.com"])).toBe(false);
  });

  it("empty domain list matches everything", () => {
    expect(cookieMatchesDomains("anything.example", [])).toBe(true);
  });
});

describe("toCookieParam", () => {
  it("keeps a full persistent cookie", () => {
    const p = toCookieParam({
      name: "SESSDATA", value: "abc", domain: ".bilibili.com", path: "/",
      expires: 1893456000, secure: true, httpOnly: true, sameSite: "Lax",
    });
    expect(p).toEqual({
      name: "SESSDATA", value: "abc", domain: ".bilibili.com", path: "/",
      secure: true, httpOnly: true, sameSite: "Lax", expires: 1893456000,
    });
  });

  it("drops expires on session cookies", () => {
    const p = toCookieParam({ name: "s", value: "v", domain: "x.com", path: "/", session: true, expires: 0 });
    expect(p).not.toHaveProperty("expires");
  });

  it("defaults path and omits invalid sameSite", () => {
    const p = toCookieParam({ name: "a", value: "b", domain: "x.com", path: "" });
    expect(p!.path).toBe("/");
    expect(p).not.toHaveProperty("sameSite");
  });

  it("rejects cookies without name or domain", () => {
    expect(toCookieParam({ name: "", value: "v", domain: "x.com", path: "/" })).toBeNull();
    expect(toCookieParam({ name: "n", value: "v", domain: "", path: "/" })).toBeNull();
    expect(toCookieParam(null as never)).toBeNull();
  });
});

describe("parseDevToolsActivePort", () => {
  it("parses the first line", () => {
    expect(parseDevToolsActivePort("51803\n/devtools/browser/abc-123")).toBe(51803);
  });
  it("rejects garbage", () => {
    expect(parseDevToolsActivePort("")).toBeNull();
    expect(parseDevToolsActivePort("abc\n")).toBeNull();
    expect(parseDevToolsActivePort("99999\n")).toBeNull();
    expect(parseDevToolsActivePort("-1\n")).toBeNull();
  });
});

describe("resolveEgoStateDir", () => {
  it("prefers EGO_LINUX_STATE_DIR", () => {
    expect(resolveEgoStateDir({ EGO_LINUX_STATE_DIR: "/custom" }, "linux")).toBe("/custom");
  });
  it("uses LOCALAPPDATA on win32", () => {
    expect(resolveEgoStateDir({ LOCALAPPDATA: "C:\\L" }, "win32")).toBe("C:\\L\\ego-lite-linux");
  });
  it("uses XDG_STATE_HOME / ~/.local/state on POSIX", () => {
    expect(resolveEgoStateDir({ HOME: "/h" }, "linux")).toBe("/h/.local/state/ego-lite-linux");
    expect(resolveEgoStateDir({ XDG_STATE_HOME: "/x", HOME: "/h" }, "linux")).toBe("/x/ego-lite-linux");
  });
});

describe("listLoginSources", () => {
  it("lists each browser's Local State profiles without dir, and Default when Local State is unreadable", async () => {
    const withState = mkdtempSync(join(tmpdir(), "ego-sources-"));
    writeFileSync(join(withState, "Local State"), JSON.stringify({
      profile: { info_cache: { Default: { name: "Personal" }, "Profile 1": { name: "Work" } } },
    }));
    const missing = join(withState, "no-such-dir");
    const sources = await listLoginSources([
      { id: "chrome", label: "Google Chrome", exePath: "/x/chrome", userDataDir: withState },
      { id: "edge", label: "Microsoft Edge", exePath: "/x/edge", userDataDir: missing },
    ]);
    expect(sources).toEqual([
      { id: "chrome", label: "Google Chrome", profiles: [{ dirName: "Default", name: "Personal" }, { dirName: "Profile 1", name: "Work" }] },
      { id: "edge", label: "Microsoft Edge", profiles: [{ dirName: "Default", name: "Default" }] },
    ]);
  });
});

// Linux branch of importLoginCookies (S11 / D6). The "browser" is a fake
// subprocess: a real node process (plus one child) whose command lines carry
// the spawn argv, so the reaping is exercised for real — never a real Chrome.
describe.skipIf(process.platform !== "linux")("importLoginCookies on Linux", () => {
  const FAKE = "const cp=require('child_process');if(!process.env.EGO_FAKE_CHILD)cp.spawn(process.execPath,['-e',process.env.EGO_FAKE_SRC,'--',...process.argv.slice(1)],{env:{...process.env,EGO_FAKE_CHILD:'1'},stdio:'ignore'});setInterval(()=>{},1000)";
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function fakeSource() {
    const root = mkdtempSync(join(tmpdir(), "ego-li-src-"));
    dirs.push(root);
    const userDataDir = join(root, "google-chrome");
    mkdirSync(join(userDataDir, "Profile 1"), { recursive: true });
    writeFileSync(join(userDataDir, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "A" }, "Profile 1": { name: "B" } } } }));
    writeFileSync(join(userDataDir, "Profile 1", "Cookies"), "sqlite-bytes");
    writeFileSync(join(userDataDir, "Profile 1", "Cookies-journal"), "journal-bytes");
    return { exePath: "/fake/chrome", userDataDir };
  }
  const listTree = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();

  function fakeSpawn(onSpawn: (argv: readonly string[]) => void) {
    const spawned: { pid: number; exited: Promise<unknown> }[] = [];
    return {
      spawned,
      subprocess: {
        spawn(spec: { argv: readonly string[] }) {
          onSpawn(spec.argv);
          const child = cpSpawn(process.execPath, ["-e", FAKE, "--", ...spec.argv], { env: { ...process.env, EGO_FAKE_SRC: FAKE }, stdio: "ignore" });
          const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((res) => child.on("exit", (exitCode, signal) => res({ exitCode, signal })));
          spawned.push({ pid: child.pid!, exited: done });
          return { done };
        },
      },
    };
  }
  const alive = (pattern: string): string => {
    try { return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim(); } catch { return ""; }
  };

  it("boots a temp copy of Local State + the profile's Cookies; the source dir gains nothing (S11/D6)", async () => {
    const src = fakeSource();
    const before = listTree(src.userDataDir);
    let tempDir = "";
    let copied: Record<string, string> = {};
    const fake = fakeSpawn((argv) => {
      expect(argv[0]).toBe("/fake/chrome");
      tempDir = argv.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
      expect(tempDir).toMatch(/[\\/]ego-login-import-\d+-\d+$/);
      expect(tempDir.startsWith(src.userDataDir)).toBe(false);
      expect(argv).toContain("--profile-directory=Profile 1");
      expect(argv).toContain("--remote-debugging-port=0");
      copied = Object.fromEntries(listTree(tempDir).map((f) => [f, existsSync(join(tempDir, f)) && !f.endsWith("Profile 1") ? readFileSync(join(tempDir, f), "utf8") : ""]));
    });
    const report = await importLoginCookies(
      { browserOverride: { id: "chrome", label: "Fake Chrome", ...src }, profile: "Profile 1", dryRun: true, timeoutMs: 300 },
      { subprocess: fake.subprocess },
    );
    expect(report.ok).toBe(false);
    expect(fake.spawned).toHaveLength(1);
    expect(copied).toEqual({
      "Local State": readFileSync(join(src.userDataDir, "Local State"), "utf8"),
      "Profile 1": "",
      "Profile 1/Cookies": "sqlite-bytes",
      "Profile 1/Cookies-journal": "journal-bytes",
    });
    expect(listTree(src.userDataDir)).toEqual(before);
    expect(readFileSync(join(src.userDataDir, "Profile 1", "Cookies"), "utf8")).toBe("sqlite-bytes");
  });

  it("port timeout: fails, removes the temp dir and ends this run's process tree (D6)", async () => {
    const src = fakeSource();
    let tempDir = "";
    const fake = fakeSpawn((argv) => {
      tempDir = argv.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    });
    const report = await importLoginCookies(
      { browserOverride: { id: "chrome", label: "Fake Chrome", ...src }, profile: "Profile 1", dryRun: true, timeoutMs: 300 },
      { subprocess: fake.subprocess },
    );
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/did not expose a DevTools port within 300ms$/);
    expect(report.closedSource).toBe(false);
    expect(existsSync(tempDir)).toBe(false);
    expect(await fake.spawned[0].exited).toMatchObject({ signal: "SIGTERM" });
    expect(alive(tempDir)).toBe("");
  });
});

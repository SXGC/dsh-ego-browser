import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/client/index.ts", import.meta.url), "utf8");

describe("watch panel input and capture status", () => {
  it("provides local keyboard proxies for floating and sidebar views", () => {
    expect(source).toMatch(/function createKeyboardProxy\(send\)/);
    expect(source).toMatch(/compositionend/);
    expect(source).toMatch(/send\([^,]+, 'insertText'/);
    expect((source.match(/keyboardProxy\.focusAt\(e,/g) || []).length).toBe(2);
  });

  it("does not gate control input on stream state or default missing status to CDP", () => {
    expect(source).not.toMatch(/status\.backend \|\| 'cdp'/);
    expect(source).not.toMatch(/targetValid[^\n]+streamState !== 'streaming'/);
  });

  it("keeps the FFmpeg option disabled until installation is ready", () => {
    expect(source).toMatch(/disabled: !ffmpegStatus\.canSelectFfmpeg/);
    expect(source).toMatch(/ffmpeg-install/);
    expect(source).toMatch(/githubMirror/);
  });
});

describe("settings login import block", () => {
  const block = source.slice(source.indexOf("function LoginImportBlock(props)"), source.indexOf("function EgoBrowserForm(props)"));
  const hostForm = source.slice(source.indexOf("function EgoHostConfigForm(props)"), source.indexOf("function isFfmpegBusy("));
  const fnSrc = source.slice(source.indexOf("function loginDomainCoveredBy("), source.indexOf("function LoginImportBlock(props)"));
  const coveredBy = new Function(`${fnSrc}; return loginDomainCoveredBy;`)() as (d: string, checked: string[]) => string | null;

  it("is mounted in both the 0.1.7 host form and the legacy form", () => {
    expect(hostForm).toMatch(/h\(LoginImportBlock, \{ t: t \}\)/);
    expect((source.match(/h\(LoginImportBlock, \{ t: t \}\)/g) || []).length).toBe(2);
  });

  it("loads sources and sends the selected profile dirName", () => {
    expect(block).toMatch(/fetch\('\/api\/ego\/login-import\/sources'\)/);
    expect(block).toMatch(/profile: profileDir \|\| undefined,/);
    expect(block).toMatch(/source === 'auto' \? sources\[0\]/);
  });

  it("imports only the ticked domains and disables import until something is ticked", () => {
    expect(block).toMatch(/domains: dryRun \? domains\.split\(','\)[^\n]+: checked,/);
    expect(block).toMatch(/disabled: running \|\| !probe \|\| checked\.length === 0/);
    // A fresh probe starts with nothing ticked.
    expect(block).toMatch(/setProbe\(res\); setChecked\(\[\]\)/);
  });

  it("shows covered subdomain rows as ticked and locked", () => {
    expect(block).toMatch(/checked: by !== null \|\| checked\.indexOf\(d\.domain\) !== -1, disabled: running \|\| by !== null/);
  });

  it("matches the server's cookieMatchesDomains rule for subdomain coverage", () => {
    expect(coveredBy("x.a.com", [".a.com"])).toBe(".a.com");
    expect(coveredBy(".x.a.com", ["a.com"])).toBe("a.com");
    expect(coveredBy("a.com", [".a.com"])).toBe(".a.com");
    expect(coveredBy(".a.com", [".a.com"])).toBeNull();
    expect(coveredBy("xa.com", [".a.com"])).toBeNull();
    expect(coveredBy("a.com", ["x.a.com"])).toBeNull();
    expect(coveredBy("b.com", [])).toBeNull();
  });
});

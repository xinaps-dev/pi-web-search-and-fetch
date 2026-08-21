import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("README.md documentation", () => {
  const readmePath = resolve(process.cwd(), "README.md");

  it("exists at repository root", () => {
    expect(existsSync(readmePath)).toBe(true);
  });

  it("documents installation and package setup", () => {
    const content = readFileSync(readmePath, "utf-8");
    expect(content).toMatch(/# pi-web-scout/i);
    expect(content).toMatch(/## .*Installation/i);
    expect(content).toMatch(/pi install/i);
  });

  it("documents the /ws command", () => {
    const content = readFileSync(readmePath, "utf-8");
    expect(content).toMatch(/\/ws/);
    expect(content).toMatch(/interactive.*Hub/i);
  });

  it("documents configuration and credential storage", () => {
    const content = readFileSync(readmePath, "utf-8");
    expect(content).toMatch(/pi-web-scout\.json/);
    expect(content).toMatch(/auth\.json/);
    expect(content).toMatch(/EXA_API_KEY/);
  });

  it("documents provider architecture and extension interfaces", () => {
    const content = readFileSync(readmePath, "utf-8");
    expect(content).toMatch(/ProviderRegistry/);
    expect(content).toMatch(/SearchProvider/);
    expect(content).toMatch(/FetchProvider/);
    expect(content).toMatch(/DeepSearchProvider/);
    expect(content).toMatch(/ProviderModule/);
  });

  it("documents the LLM tools and Requesty integration", () => {
    const content = readFileSync(readmePath, "utf-8");
    expect(content).toMatch(/`web_search`/);
    expect(content).toMatch(/`web_fetch`/);
    expect(content).toMatch(/`web_deep_search`/);
    expect(content).toMatch(/pi-requesty/);
  });
});

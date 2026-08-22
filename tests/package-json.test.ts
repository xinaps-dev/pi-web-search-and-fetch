import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("package.json metadata and pi configuration", () => {
  const packageJsonPath = path.resolve(__dirname, "../package.json");
  const rawContent = fs.readFileSync(packageJsonPath, "utf-8");
  const pkg = JSON.parse(rawContent);

  it("defines the Pi extension entry point in the 'pi' configuration section", () => {
    expect(pkg.pi).toBeDefined();
    expect(pkg.pi.extensions).toBeDefined();
    expect(Array.isArray(pkg.pi.extensions)).toBe(true);
    expect(pkg.pi.extensions).toContain("./index.ts");
  });

  it("specifies distribution files that exist on disk", () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain("index.ts");
    expect(pkg.files).toContain("src");
    expect(pkg.files).toContain("README.md");
    expect(pkg.files).toContain("LICENSE");

    for (const item of pkg.files) {
      const itemPath = path.resolve(__dirname, "..", item);
      expect(fs.existsSync(itemPath), `File/directory specified in "files" should exist: ${item}`).toBe(true);
    }
  });

  it("includes npm discovery keywords for Pi packages and extensions", () => {
    expect(Array.isArray(pkg.keywords)).toBe(true);
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.keywords).toContain("pi-extension");
    expect(pkg.keywords).toContain("pi");
    expect(pkg.keywords).toContain("pi-coding-agent");
    expect(pkg.keywords).toContain("web-search");
    expect(pkg.keywords).toContain("web-search-and-fetch");
  });

  it("contains essential metadata for npm publishing", () => {
    expect(pkg.name).toBe("pi-web-search-and-fetch");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof pkg.description).toBe("string");
    expect(pkg.description.length).toBeGreaterThan(0);
    expect(pkg.license).toBe("MIT");
    expect(pkg.type).toBe("module");
    expect(pkg.main).toBe("index.ts");
    expect(pkg.types).toBe("index.ts");
    expect(pkg.author).toBeDefined();
    expect(pkg.repository).toBeDefined();
    expect(pkg.repository.type).toBe("git");
    expect(pkg.repository.url).toContain("github.com");
    expect(pkg.homepage).toBeDefined();
    expect(pkg.bugs).toBeDefined();
  });

  it("defines prepublish verification scripts", () => {
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.prepublishOnly).toBeDefined();
  });
});

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface NamedJsonFixture<Value> {
  readonly name: string;
  readonly relativePath: string;
  readonly value: Value;
}

export interface FixtureLoader {
  readonly rootDirectory: string;
  readonly text: (relativePath: string) => string;
  readonly json: <Value>(relativePath: string) => Value;
  readonly jsonDirectory: <Value>(
    relativeDirectory: string,
  ) => readonly NamedJsonFixture<Value>[];
}

function inputPath(input: string | URL): string {
  return input instanceof URL ? fileURLToPath(input) : input;
}

function isWithinRoot(rootDirectory: string, target: string): boolean {
  const pathFromRoot = relative(rootDirectory, target);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function assertRelativePath(relativePath: string): void {
  if (relativePath.trim() === "" || isAbsolute(relativePath)) {
    throw new TypeError("Fixture path must be a non-empty relative path");
  }
}

export function createFixtureLoader(root: string | URL): FixtureLoader {
  const rootDirectory = realpathSync(inputPath(root));

  const fixturePath = (relativePath: string): string => {
    assertRelativePath(relativePath);
    const unresolved = resolve(rootDirectory, relativePath);
    if (!isWithinRoot(rootDirectory, unresolved)) {
      throw new TypeError(`Fixture path escapes its root: ${relativePath}`);
    }
    const resolved = realpathSync(unresolved);
    if (!isWithinRoot(rootDirectory, resolved)) {
      throw new TypeError(`Fixture symlink escapes its root: ${relativePath}`);
    }
    return resolved;
  };

  const text = (relativePath: string): string =>
    readFileSync(fixturePath(relativePath), "utf8");

  const json = <Value>(relativePath: string): Value => {
    try {
      return JSON.parse(text(relativePath)) as Value;
    } catch (error: unknown) {
      throw new SyntaxError(`Invalid JSON fixture: ${relativePath}`, {
        cause: error,
      });
    }
  };

  const jsonDirectory = <Value>(
    relativeDirectory: string,
  ): readonly NamedJsonFixture<Value>[] => {
    const directory = fixturePath(relativeDirectory);
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => ({
        name,
        relativePath: `${relativeDirectory.replaceAll(/\/+$/gu, "")}/${name}`,
        value: json<Value>(
          `${relativeDirectory.replaceAll(/\/+$/gu, "")}/${name}`,
        ),
      }));
  };

  return Object.freeze({ rootDirectory, text, json, jsonDirectory });
}

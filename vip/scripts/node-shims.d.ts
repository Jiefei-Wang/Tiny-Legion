declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function existsSync(path: string): boolean;
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
}

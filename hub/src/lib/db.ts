import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import type { PanelLayout } from "./layout";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "hub.json");

export type Role = "admin" | "user";

export type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
};

export type PanelRow = {
  id: number;
  name: string;
  host: string;
  token: string;
  owner_user_id: number | null;
  strip_height: number;
  enabled: number;
};

type DbShape = {
  users: UserRow[];
  panels: PanelRow[];
  layouts: Record<string, PanelLayout>;
  nextUserId: number;
  nextPanelId: number;
};

let cache: DbShape | null = null;

function defaultDb(): DbShape {
  const hash = bcrypt.hashSync("admin", 10);
  const panelToken = process.env.PANEL_DEFAULT_TOKEN || "ledpanel-dev-token";
  return {
    users: [{ id: 1, username: "admin", password_hash: hash, role: "admin" }],
    panels: [
      {
        id: 1,
        name: "Lab panel",
        host: "192.168.1.52",
        token: panelToken,
        owner_user_id: 1,
        strip_height: 16,
        enabled: 1,
      },
    ],
    layouts: {},
    nextUserId: 2,
    nextPanelId: 2,
  };
}

export function getDb(): DbShape {
  if (cache) return cache;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    cache = defaultDb();
    saveDb();
    return cache;
  }
  cache = JSON.parse(fs.readFileSync(dbPath, "utf8")) as DbShape;
  if (!cache.layouts) cache.layouts = {};
  return cache;
}

export function saveDb(): void {
  if (!cache) return;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(cache, null, 2), "utf8");
}

import fs from "fs";
import path from "path";

export interface LinkedUser {
  username: string;
  sessionKey: string;
}

const filePath = path.join(__dirname, "../../data/data.json");
let data: Record<string, LinkedUser> = {};

export function loadData() {
  if (fs.existsSync(filePath)) {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }
}

export function saveData() {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function linkUser(uid: string, username: string, sessionKey: string) {
  data[uid] = { username, sessionKey };
  saveData();
}

export function getUser(uid: string): LinkedUser | undefined {
  return data[uid];
}

export function unlinkUser(uid: string) {
  delete data[uid];
  saveData();
}
// ... your other functions like getUser, linkUser ...

export function getLinkedUserIds(): string[] {
  return Object.keys(data);
}


loadData();

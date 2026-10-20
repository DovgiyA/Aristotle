// Процесс для теста гонки Ключа Группы (T069 фичи 003): открыть Банк и выполнить ensureGroupKey, как
// служба при запуске; напечатать открытый ключ подписи и доступность одной строкой JSON.
import { closeDatabase, ensureGroupKey, openBank, readInstall } from "@aristotel/core";

const dir = process.argv[2];
if (dir === undefined) throw new Error("data dir");
const db = openBank(dir, readInstall(dir));
const handle = await ensureGroupKey(dir, db);
process.stdout.write(JSON.stringify({ signingKey: handle.info().signingKey, available: handle.available }) + "\n");
closeDatabase(db);

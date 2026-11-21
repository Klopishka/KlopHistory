// Сборщик данных: запрашивает историю продаж артефактов и дописывает в JSON-файлы.
// Запуск: node collect.js <папка-для-данных>
import fs from 'node:fs/promises';
import path from 'node:path';

const { STALCRAFT_TOKEN, REGION = 'RU' } = process.env;
if (!STALCRAFT_TOKEN) {
  console.error('Нет STALCRAFT_TOKEN');
  process.exit(1);
}

const OUT = process.argv[2] || 'data';
const SALES_DIR = path.join(OUT, 'sales');
const API = `https://eapi.stalcraft.net/${REGION}`;
const LISTING =
  'https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru/listing.json';

const MAX_PAGES = 10;      // сколько страниц по 200 записей забирать за один заход
const LIMIT = 200;
const MAX_ROWS = 20000;    // потолок записей на один предмет (чтобы файлы не росли бесконечно)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${STALCRAFT_TOKEN}` } });
    if (res.status === 429) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }
  throw new Error(`429 слишком много запросов: ${url}`);
}

async function loadItems() {
  const res = await fetch(LISTING);
  if (!res.ok) throw new Error('Не удалось скачать listing.json');
  const list = await res.json();
  const items = [];
  for (const it of list) {
    if (!it.data?.includes('/artefact/')) continue;
    const id = it.data.split('/').pop().replace('.json', '');
    const name = typeof it.name === 'string' ? it.name : it.name?.lines?.ru || it.name?.lines?.en;
    if (name) items.push({ id, name });
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return items;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// строка продажи: [время_мс, цена, количество, качество, тир]
const keyOf = (r) => r.join('|');

async function collectItem(id) {
  const file = path.join(SALES_DIR, `${id}.json`);
  const rows = await readJson(file, []);
  const known = new Set(rows.map(keyOf));
  let added = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await apiGet(
      `${API}/auction/${id}/history?additional=true&limit=${LIMIT}&offset=${page * LIMIT}`
    );
    const prices = data.prices || [];
    let newOnPage = 0;
    for (const p of prices) {
      const t = Date.parse(p.time);
      if (Number.isNaN(t)) continue;
      const row = [t, p.price, p.amount ?? 1, p.additional?.qlt ?? 0, p.additional?.ptn ?? 0];
      const k = keyOf(row);
      if (known.has(k)) continue;
      known.add(k);
      rows.push(row);
      newOnPage++;
    }
    added += newOnPage;
    if (newOnPage === 0 || prices.length < LIMIT) break;
    await sleep(250);
  }

  if (added > 0 || rows.length === 0) {
    rows.sort((a, b) => b[0] - a[0]);
    await fs.writeFile(file, JSON.stringify(rows.slice(0, MAX_ROWS)));
  }
  return added;
}

await fs.mkdir(SALES_DIR, { recursive: true });

let items;
try {
  items = await loadItems();
  await fs.writeFile(path.join(OUT, 'items.json'), JSON.stringify(items));
} catch (e) {
  console.error('Список предметов:', e.message);
  items = await readJson(path.join(OUT, 'items.json'), []);
}
console.log(`Артефактов: ${items.length}`);

let total = 0;
for (const it of items) {
  try {
    total += await collectItem(it.id);
  } catch (e) {
    console.error(`Ошибка ${it.id}:`, e.message);
  }
  await sleep(250);
}

await fs.writeFile(path.join(OUT, 'meta.json'), JSON.stringify({ updated: Date.now() }));
console.log(`Готово, новых записей: ${total}`);

// holiday-calendar: returns Canadian statutory holidays for a date range and/or province.
// Useful for transit-time calculations: skip stat holidays when projecting delivery dates.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

// Federal + per-province holidays we observe for freight transit. Static authoritative list.
// Format: { date: 'YYYY-MM-DD', name, federal, provinces[] }
function yearHolidays(year: number) {
  const set = (m: number, d: number) => `${year}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;

  // 3rd Monday of February (Family Day in most provinces)
  const familyDay = nthWeekday(year, 2, 1, 3);
  // Easter calc (Western Easter)
  const easter = westernEaster(year);
  const goodFriday = new Date(easter); goodFriday.setDate(goodFriday.getDate() - 2);
  const easterMonday = new Date(easter); easterMonday.setDate(easterMonday.getDate() + 1);
  // Victoria Day = Monday on/before May 24
  const victoriaDay = lastMondayOnOrBefore(year, 5, 24);
  // Canada Day Jul 1
  const canadaDay = set(7, 1);
  // Civic Holiday = 1st Monday August
  const civicHoliday = nthWeekday(year, 8, 1, 1);
  // Labour Day = 1st Monday September
  const labourDay = nthWeekday(year, 9, 1, 1);
  // National Truth & Reconciliation Day = Sep 30 (federal since 2021)
  const truthReconciliation = set(9, 30);
  // Thanksgiving = 2nd Monday October
  const thanksgiving = nthWeekday(year, 10, 1, 2);
  // Remembrance Day = Nov 11
  const remembrance = set(11, 11);
  // Christmas Dec 25 / Boxing Day Dec 26
  const christmas = set(12, 25);
  const boxingDay = set(12, 26);
  // Saint-Jean-Baptiste = Jun 24 (QC)
  const stjean = set(6, 24);

  const ALL = ["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"];
  return [
    { date: set(1,1), name: "New Year's Day", federal: true, provinces: ALL },
    { date: familyDay, name: "Family Day", federal: false, provinces: ["AB","BC","NB","ON","SK"] },
    { date: goodFriday.toISOString().slice(0,10), name: "Good Friday", federal: true, provinces: ALL },
    { date: easterMonday.toISOString().slice(0,10), name: "Easter Monday", federal: true, provinces: ["QC"] },
    { date: victoriaDay, name: "Victoria Day", federal: true, provinces: ALL.filter(p => p !== "NS") },
    { date: stjean, name: "Saint-Jean-Baptiste", federal: false, provinces: ["QC"] },
    { date: canadaDay, name: "Canada Day", federal: true, provinces: ALL },
    { date: civicHoliday, name: "Civic Holiday", federal: false, provinces: ["AB","BC","NB","NT","NU","ON","SK"] },
    { date: labourDay, name: "Labour Day", federal: true, provinces: ALL },
    { date: truthReconciliation, name: "National Day for Truth and Reconciliation", federal: true, provinces: ["BC","MB","NT","NU","PE","YT"] },
    { date: thanksgiving, name: "Thanksgiving", federal: true, provinces: ALL.filter(p => !["NB","NS","NL","PE"].includes(p)) },
    { date: remembrance, name: "Remembrance Day", federal: true, provinces: ["AB","BC","NB","NL","NT","NU","PE","SK","YT"] },
    { date: christmas, name: "Christmas Day", federal: true, provinces: ALL },
    { date: boxingDay, name: "Boxing Day", federal: false, provinces: ["ON"] }
  ];
}

function nthWeekday(year: number, month: number, weekday: number, n: number) {
  // weekday: 0=Sun, 1=Mon, ... 6=Sat. month: 1-12
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWd = first.getUTCDay();
  const offset = (weekday - firstWd + 7) % 7;
  const d = new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7));
  return d.toISOString().slice(0,10);
}
function lastMondayOnOrBefore(year: number, month: number, day: number) {
  const d = new Date(Date.UTC(year, month - 1, day));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0,10);
}
// Anonymous Gregorian algorithm
function westernEaster(year: number) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const u = new URL(req.url);
  const from = String(u.searchParams.get("from") || "").slice(0,10);
  const to   = String(u.searchParams.get("to") || "").slice(0,10);
  const province = String(u.searchParams.get("province") || "").toUpperCase().slice(0,2);
  const fromDate = from ? new Date(from) : new Date();
  const toDate = to ? new Date(to) : new Date(Date.UTC(fromDate.getUTCFullYear() + 1, fromDate.getUTCMonth(), fromDate.getUTCDate()));

  const startYear = fromDate.getUTCFullYear();
  const endYear = toDate.getUTCFullYear();
  const all: any[] = [];
  for (let y = startYear; y <= endYear; y++) all.push(...yearHolidays(y));

  const fromStr = fromDate.toISOString().slice(0,10);
  const toStr = toDate.toISOString().slice(0,10);
  const filtered = all.filter(h => {
    if (h.date < fromStr || h.date > toStr) return false;
    if (province) return h.federal || (h.provinces && h.provinces.includes(province));
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));

  return json({ ok: true, from: fromStr, to: toStr, province: province || null, holidays: filtered });
});

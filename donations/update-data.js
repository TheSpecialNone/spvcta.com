const fs = require("fs");
const path = require("path");

const USE_LIVE_FETCH = true;
const GROUP_ID = process.env.ROBLOX_GROUP_ID || "35995419";
const GOAL = 24800;
const SALES_CUTOFF_DATE = "2026-03-29T13:46:20.411Z";
const TRANSFERS_CUTOFF_DATE = "2026-09-01T00:00:00.000Z";
const OUTPUT_PATH = path.join(__dirname, "donations.json");
const RAW_INPUT_PATH = path.join(__dirname, "raw-transactions.json");

function loadManualTransactions() {
  if (!fs.existsSync(RAW_INPUT_PATH)) {
    console.error(`Missing ${RAW_INPUT_PATH}. Create it with rows copied from`);
    console.error("your Sales of Goods page, or set USE_LIVE_FETCH = true.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(RAW_INPUT_PATH, "utf8"));
}

async function fetchAuthenticatedUserId(cookie) {
  const res = await fetch("https://users.roblox.com/v1/users/authenticated", {
    headers: { Cookie: `.ROBLOSECURITY=${cookie}` },
  });
  if (!res.ok) {
    console.warn("Could not identify authenticated account:", res.status);
    return null;
  }
  const { id } = await res.json();
  return id;
}

async function fetchGroupSales(cookie) {
  const transactions = [];
  let cursor = "";

  do {
    const url =
      `https://apis.roblox.com/transaction-records/v1/groups/${GROUP_ID}/transactions` +
      `?cursor=${encodeURIComponent(cursor)}&limit=100&transactionType=Sale`;

    const res = await fetch(url, { headers: { Cookie: `.ROBLOSECURITY=${cookie}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Roblox request failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
    }

    const json = await res.json();
    for (const row of json.data) {
      transactions.push({
        buyer: row.agent.name,
        amount: row.currency.amount,
        userId: row.agent.id,
        created: row.created,
      });
    }
    cursor = json.nextPageCursor || "";
  } while (cursor);

  return transactions;
}

async function fetchIncomingTransfers(cookie, userId) {
  if (!userId) return [];
  const transactions = [];
  let cursor = "";

  do {
    const url =
      `https://apis.roblox.com/transaction-records/v1/users/${userId}/transactions` +
      `?cursor=${encodeURIComponent(cursor)}&limit=100&transactionType=CurrencyTransfer&itemPricingType=PaidAndLimited`;

    const res = await fetch(url, { headers: { Cookie: `.ROBLOSECURITY=${cookie}` } });
    if (!res.ok) {
      console.warn("Could not fetch incoming transfers, skipping:", res.status);
      return transactions;
    }

    const json = await res.json();
    for (const row of json.data) {
      if (row.details.transferRole !== "Receiver") continue;
      transactions.push({
        buyer: row.details.counterPartyName,
        amount: row.currency.amount,
        userId: Number(row.details.senderTargetId) || null,
        created: row.created,
      });
    }
    cursor = json.nextPageCursor || "";
  } while (cursor);

  return transactions;
}

function filterByCutoff(transactions, cutoffIso) {
  if (!cutoffIso) return transactions;
  const cutoff = new Date(cutoffIso).getTime();
  return transactions.filter(t => !t.created || new Date(t.created).getTime() > cutoff);
}

function aggregate(transactions) {
  const totals = new Map();

  for (const t of transactions) {
    const key = t.userId || t.buyer;
    const existing = totals.get(key) || { name: t.buyer, userId: t.userId || null, amount: 0 };
    existing.amount += t.amount;
    totals.set(key, existing);
  }

  return Array.from(totals.values()).sort((a, b) => b.amount - a.amount);
}

async function fetchAvatars(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const avatarByUserId = {};
  if (!ids.length) return avatarByUserId;

  const CHUNK_SIZE = 100;
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const url =
      `https://thumbnails.roblox.com/v1/users/avatar-headshot` +
      `?userIds=${chunk.join(",")}&size=150x150&format=Png&isCircular=true`;

    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      for (const item of json.data) {
        if (item.state === "Completed") avatarByUserId[item.targetId] = item.imageUrl;
      }
    } catch (err) {
      console.warn("Avatar fetch chunk failed, continuing without it:", err.message);
    }
  }

  return avatarByUserId;
}

async function fetchUserInfo(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const infoByUserId = {};
  if (!ids.length) return infoByUserId;

  const CHUNK_SIZE = 100;
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);

    try {
      const res = await fetch("https://users.roblox.com/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: chunk, excludeBannedUsers: false }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      for (const item of json.data) {
        infoByUserId[item.id] = { username: item.name, displayName: item.displayName };
      }
    } catch (err) {
      console.warn("User info fetch chunk failed, continuing without it:", err.message);
    }
  }

  return infoByUserId;
}

async function fetchAccountRobuxBalance(cookie, userId) {
  if (!cookie || !userId) return { available: 0, pending: 0 };

  try {
    const currencyRes = await fetch(`https://economy.roblox.com/v1/users/${userId}/currency`, {
      headers: { Cookie: `.ROBLOSECURITY=${cookie}` },
    });
    const available = currencyRes.ok ? (await currencyRes.json()).robux || 0 : 0;
    if (!currencyRes.ok) console.warn("Could not fetch spendable balance, skipping:", currencyRes.status);

    const totalsUrl =
      `https://apis.roblox.com/transaction-records/v1/users/${userId}/transaction-totals` +
      `?usedTypes=573037616&timeFrame=Month&transactionType=summary`;
    const totalsRes = await fetch(totalsUrl, { headers: { Cookie: `.ROBLOSECURITY=${cookie}` } });
    const pending = totalsRes.ok ? (await totalsRes.json()).pendingRobuxTotal || 0 : 0;
    if (!totalsRes.ok) console.warn("Could not fetch pending balance, skipping:", totalsRes.status);

    return { available, pending };
  } catch (err) {
    console.warn("Account balance fetch failed, continuing without it:", err.message);
    return { available: 0, pending: 0 };
  }
}

async function fetchGroupRobuxBalance(cookie, groupId) {
  if (!cookie || !groupId) return { available: 0, pending: 0 };

  try {
    const currencyRes = await fetch(`https://economy.roblox.com/v1/groups/${groupId}/currency`, {
      headers: { Cookie: `.ROBLOSECURITY=${cookie}` },
    });
    const available = currencyRes.ok ? (await currencyRes.json()).robux || 0 : 0;
    if (!currencyRes.ok) console.warn("Could not fetch group balance, skipping:", currencyRes.status);

    const totalsUrl =
      `https://apis.roblox.com/transaction-records/v1/groups/${groupId}/transaction-totals` +
      `?timeFrame=Month&transactionType=summary`;
    const totalsRes = await fetch(totalsUrl, { headers: { Cookie: `.ROBLOSECURITY=${cookie}` } });
    const pending = totalsRes.ok ? (await totalsRes.json()).pendingRobuxTotal || 0 : 0;
    if (!totalsRes.ok) console.warn("Could not fetch group pending balance, skipping:", totalsRes.status);

    return { available, pending };
  } catch (err) {
    console.warn("Group balance fetch failed, continuing without it:", err.message);
    return { available: 0, pending: 0 };
  }
}

async function main() {
  const cookie = process.env.ROBLOX_COOKIE;

  let salesTransactions = [];
  let transferTransactions = [];
  let userBalance = { available: 0, pending: 0 };
  let groupBalance = { available: 0, pending: 0 };

  if (USE_LIVE_FETCH) {
    const authUserId = await fetchAuthenticatedUserId(cookie);
    salesTransactions = await fetchGroupSales(cookie);
    transferTransactions = await fetchIncomingTransfers(cookie, authUserId);
    userBalance = await fetchAccountRobuxBalance(cookie, authUserId);
    groupBalance = await fetchGroupRobuxBalance(cookie, GROUP_ID);
  } else {
    salesTransactions = loadManualTransactions();
  }

  const salesFiltered = filterByCutoff(salesTransactions, SALES_CUTOFF_DATE);
  const transfersFiltered = filterByCutoff(transferTransactions, TRANSFERS_CUTOFF_DATE);

  const topDonators = aggregate([...salesFiltered, ...transfersFiltered]);
  const salesTotal = salesFiltered.reduce((sum, t) => sum + t.amount, 0);

  const totalRaised =
    userBalance.available + userBalance.pending + groupBalance.available + groupBalance.pending;

  const userIds = topDonators.map(d => d.userId);
  const [avatarByUserId, userInfoByUserId] = await Promise.all([
    fetchAvatars(userIds),
    fetchUserInfo(userIds),
  ]);

  const enrichedDonators = topDonators.map(d => {
    const info = d.userId ? userInfoByUserId[d.userId] : null;
    const username = info ? info.username : d.name;
    const displayName = info ? info.displayName : d.name;
    return {
      name: username,
      displayName,
      amount: d.amount,
      userId: d.userId,
      avatarUrl: d.userId ? avatarByUserId[d.userId] || null : null,
    };
  });

  const data = {
    totalRaised,
    salesTotal,
    userAvailableRobux: userBalance.available,
    userPendingRobux: userBalance.pending,
    groupAvailableRobux: groupBalance.available,
    groupPendingRobux: groupBalance.pending,
    goal: GOAL,
    lastUpdated: new Date().toISOString(),
    topDonators: enrichedDonators,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));
  console.log(
    `Wrote ${OUTPUT_PATH} — total raised: ${totalRaised} ` +
    `(user: ${userBalance.available}+${userBalance.pending}, group: ${groupBalance.available}+${groupBalance.pending}) / ${GOAL}`
  );
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

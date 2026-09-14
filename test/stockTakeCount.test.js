// Stock take counting — the rules that make a count trustworthy.
//
// Each of these protects something that is invisible when it breaks: a count
// that silently doubles, a recount done by the person who got it wrong the
// first time, or a shortfall that never appears because nobody scanned it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
let clock = 0;
memDb.function('now_local', () => `2026-09-14 08:00:${String(clock++).padStart(2, '0')}`);
memDb.exec(`
  CREATE TABLE stocktake_item (
    item_number TEXT NOT NULL, unit TEXT NOT NULL, conversion REAL NOT NULL DEFAULT 1,
    item_description TEXT, stock_unit TEXT, category TEXT, category_description TEXT, commodity TEXT,
    inactive INTEGER NOT NULL DEFAULT 0, synced_at TEXT,
    PRIMARY KEY (item_number, unit)
  );
  CREATE TABLE item_barcode (
    id INTEGER PRIMARY KEY AUTOINCREMENT, barcode TEXT NOT NULL UNIQUE,
    item_number TEXT NOT NULL, unit TEXT NOT NULL,
    created_by TEXT, created_date TEXT, updated_by TEXT, updated_date TEXT
  );
  CREATE TABLE inventory_location_onhand (
    item_number TEXT NOT NULL, location TEXT NOT NULL,
    qty_on_hand REAL, total_cost REAL, synced_at TEXT,
    PRIMARY KEY (item_number, location)
  );
  CREATE TABLE stocktake_session (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', categories TEXT, commodities TEXT, threshold_qty REAL NOT NULL DEFAULT 1,
    threshold_value REAL NOT NULL DEFAULT 500, opened_by TEXT, opened_date TEXT,
    closed_by TEXT, closed_date TEXT, notes TEXT
  );
  CREATE TABLE stocktake_location_zone (
    id INTEGER PRIMARY KEY AUTOINCREMENT, location TEXT NOT NULL, name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
    created_by TEXT, created_date TEXT, UNIQUE (location, name)
  );
  CREATE TABLE stocktake_zone (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, location_zone_id INTEGER,
    name TEXT NOT NULL,
    assigned_to TEXT, status TEXT NOT NULL DEFAULT 'open', created_by TEXT, created_date TEXT,
    submitted_by TEXT, submitted_date TEXT, UNIQUE (session_id, name)
  );
  CREATE TABLE stocktake_scan (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL UNIQUE,
    session_id INTEGER NOT NULL, zone_id INTEGER NOT NULL, pass INTEGER NOT NULL DEFAULT 1,
    barcode TEXT, item_number TEXT, unit TEXT, conversion REAL NOT NULL DEFAULT 1,
    qty REAL NOT NULL, stock_qty REAL NOT NULL, counted_by TEXT NOT NULL,
    counted_at TEXT, received_at TEXT NOT NULL, voided INTEGER NOT NULL DEFAULT 0,
    voided_by TEXT, voided_date TEXT, note TEXT
  );
  CREATE TABLE stocktake_session_snapshot (
    session_id INTEGER NOT NULL, item_number TEXT NOT NULL,
    qty_on_hand REAL NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, item_number)
  );
`);

vi.mock('../src/db/index.js', () => ({ default: memDb }));
vi.mock('../src/services/batReconciliation.js', () => ({ getSagePool: vi.fn() }));
vi.mock('../src/lib/errorLog.js', () => ({ logError: vi.fn() }));

const {
  openSession, closeSession, addLocationZone, listLocationZones, setLocationZoneActive,
  claimZone, releaseZone, submitZone, recordScans, listZones,
  getVariance, listRecountItems, resolveForCount, voidScan, listUnresolvedScans,
  listCategories, listCommodities, searchItemsForCount, getZoneSummary, getZoneItems,
} = await import('../src/services/stockTakeCount.js');

/** @type {any} */ let session;
/** @type {any} */ let zone;

/** The zone a count created from the branch's list, by name. */
const zoneNamed = (sessionId, name) => listZones(sessionId).find((z) => z.name === name);

beforeEach(() => {
  memDb.exec(`
    DELETE FROM stocktake_scan; DELETE FROM stocktake_zone; DELETE FROM stocktake_location_zone;
    DELETE FROM stocktake_session_snapshot; DELETE FROM stocktake_session;
    DELETE FROM stocktake_item; DELETE FROM item_barcode; DELETE FROM inventory_location_onhand;
  `);
  memDb.prepare("INSERT INTO stocktake_item VALUES ('110','CTN',1,'PETER BLUE 10S','CTN','20S','Cigarettes 20s','2',0,'x')").run();
  memDb.prepare("INSERT INTO stocktake_item VALUES ('4010','CTN',1,'CAMEL SENSO','CTN','20S','Cigarettes 20s','2',0,'x')").run();
  memDb.prepare("INSERT INTO stocktake_item VALUES ('9','BOX',1,'SWEETS','BOX','SWT','Sweets','1',0,'x')").run();
  // 110: 100 on hand at R391.58; 4010: 20 at R405.15; 9: 5 at R10.
  memDb.prepare("INSERT INTO inventory_location_onhand VALUES ('110','POL',100,39158,'x')").run();
  memDb.prepare("INSERT INTO inventory_location_onhand VALUES ('4010','POL',20,8103,'x')").run();
  memDb.prepare("INSERT INTO inventory_location_onhand VALUES ('9','POL',5,50,'x')").run();
  // The branch's aisles, set up once by a supervisor.
  addLocationZone({ location: 'POL', name: 'Aisle 1', user: 'sean' });
  addLocationZone({ location: 'POL', name: 'Aisle 2', user: 'sean' });
  session = openSession({ name: 'Sept', location: 'POL', thresholdQty: 2, thresholdValue: 500, user: 'sean' });
  zone = claimZone({ zoneId: zoneNamed(session.id, 'Aisle 1').id, user: 'trudy' });
});

const scan = (over = {}) => ({ client_id: `c${Math.random()}`, item_number: '110', unit: 'CTN', qty: 10, ...over });

describe('opening a count', () => {
  it('freezes what Sage expected, so sales during the count are not read as shortfalls', () => {
    expect(session.snapshot_rows).toBe(3);
    memDb.prepare("UPDATE inventory_location_onhand SET qty_on_hand = 1 WHERE item_number = '110'").run();
    const row = getVariance(session.id, { filter: 'all' }).rows.find((r) => r.item_number === '110');
    expect(row.expected_qty).toBe(100);
  });

  it('refuses a second open count at the same branch', () => {
    expect(() => openSession({ name: 'Another', location: 'POL', user: 'sean' })).toThrowError(/already an open count/i);
  });
});

describe('zones', () => {
  it('gives a new count every aisle the branch has', () => {
    expect(listZones(session.id).map((z) => z.name)).toEqual(['Aisle 1', 'Aisle 2']);
  });

  it('will not let a second person take a zone someone is already counting', () => {
    expect(() => claimZone({ zoneId: zone.id, user: 'james' }))
      .toThrowError(/already being counted by trudy/i);
  });

  it('frees a zone up again when its counter gives it back', () => {
    releaseZone({ zoneId: zone.id, user: 'trudy' });
    expect(claimZone({ zoneId: zone.id, user: 'james' }).assigned_to).toBe('james');
  });

  it('refuses two aisles with the same name, which is the point of the list', () => {
    expect(() => addLocationZone({ location: 'POL', name: 'aisle 1', user: 'sean' }))
      .toThrowError(/already has a zone called/i);
  });

  it('adds a new aisle straight into the count that is already open', () => {
    addLocationZone({ location: 'POL', name: 'Cold room', user: 'sean' });
    expect(listZones(session.id).map((z) => z.name)).toContain('Cold room');
  });

  it('retires an aisle without erasing it from counts already done', () => {
    const [aisle2] = listLocationZones('POL').filter((z) => z.name === 'Aisle 2');
    setLocationZoneActive({ id: aisle2.id, active: false, user: 'sean' });
    expect(listLocationZones('POL').map((z) => z.name)).toEqual(['Aisle 1']);
    expect(listZones(session.id).map((z) => z.name)).toContain('Aisle 2');
  });

  it('stops taking scans once it is handed in', () => {
    submitZone({ zoneId: zone.id, user: 'trudy' });
    expect(() => recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan()], user: 'trudy' }))
      .toThrowError(/no longer takes scans/i);
  });
});

describe('counting part of the branch', () => {
  it('leaves everything outside the chosen product groups out of the count', () => {
    closeSession({ id: session.id, user: 'sean', force: true });
    const cigs = openSession({ name: 'Cigs only', location: 'POL', categories: ['20S'], user: 'sean' });
    const items = getVariance(cigs.id, { filter: 'all' }).rows.map((r) => r.item_number).sort();
    expect(items).toEqual(['110', '4010']);
    expect(cigs.snapshot_rows).toBe(2);
  });

  it('refuses a product group Sage does not have', () => {
    closeSession({ id: session.id, user: 'sean', force: true });
    expect(() => openSession({ name: 'Nope', location: 'POL', categories: ['WIDGETS'], user: 'sean' }))
      .toThrowError(/no product group called WIDGETS/i);
  });

  it(`scopes by commodity as well, which is Sage's other grouping`, () => {
    closeSession({ id: session.id, user: 'sean', force: true });
    const sweets = openSession({ name: 'Sweets', location: 'POL', commodities: ['1'], user: 'sean' });
    expect(getVariance(sweets.id, { filter: 'all' }).rows.map((r) => r.item_number)).toEqual(['9']);
  });

  it('takes an item that matches EITHER the group or the commodity picked', () => {
    closeSession({ id: session.id, user: 'sean', force: true });
    // Sweets by commodity, cigarettes by category — both slices, one count.
    const both = openSession({ name: 'Mixed', location: 'POL', categories: ['20S'], commodities: ['1'], user: 'sean' });
    expect(getVariance(both.id, { filter: 'all' }).rows.map((r) => r.item_number).sort()).toEqual(['110', '4010', '9']);
  });

  it('refuses a commodity Sage does not have', () => {
    closeSession({ id: session.id, user: 'sean', force: true });
    expect(() => openSession({ name: 'Nope', location: 'POL', commodities: ['99'], user: 'sean' }))
      .toThrowError(/no commodity 99/i);
  });

  it('lists the commodities a branch holds stock in', () => {
    expect(listCommodities('POL').map((c) => c.commodity).sort()).toEqual(['1', '2']);
    expect(listCommodities('POL').find((c) => c.commodity === '2').stocked_items).toBe(2);
  });

  it('lists the groups a branch actually holds stock in', () => {
    expect(listCategories('POL').map((c) => c.category).sort()).toEqual(['20S', 'SWT']);
    expect(listCategories('POL').find((c) => c.category === 'SWT').category_description).toBe('Sweets');
  });
});

describe('when a barcode will not scan', () => {
  it('finds the item by name, without letting a counter see any quantity', () => {
    const [hit] = searchItemsForCount({ q: 'PETER' });
    expect(hit).toMatchObject({ item_number: '110', stock_unit: 'CTN' });
    expect(Object.keys(hit)).not.toContain('qty_on_hand');
  });

  it('offers only the groups the count covers', () => {
    closeSession({ id: session.id, user: 'sean', force: true });
    const cigs = openSession({ name: 'Cigs only', location: 'POL', categories: ['20S'], user: 'sean' });
    expect(searchItemsForCount({ q: 'SWEET', sessionId: cigs.id })).toHaveLength(0);
    expect(searchItemsForCount({ q: 'SWEET' })).toHaveLength(1);
  });

  it('counts an item picked by name, with no barcode at all', () => {
    const r = recordScans({
      sessionId: session.id, zoneId: zone.id, user: 'trudy',
      scans: [{ client_id: 'by-name-1', item_number: '110', unit: 'CTN', qty: 100, barcode: null }],
    });
    expect(r.accepted_count).toBe(1);
    expect(getVariance(session.id, { filter: 'all' }).rows.find((x) => x.item_number === '110').counted_qty).toBe(100);
  });
});

describe('what each zone found', () => {
  it('reports quantity and value per zone', () => {
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 40 })], user: 'trudy' });
    const [first] = getZoneSummary(session.id).filter((z) => z.id === zone.id);
    expect(first).toMatchObject({ name: 'Aisle 1', items: 1, counted_qty: 40 });
    expect(first.counted_value).toBeCloseTo(40 * 391.58, 0);
  });

  it('names the other zone when two of them counted the same item', () => {
    const other = claimZone({ zoneId: zoneNamed(session.id, 'Aisle 2').id, user: 'james' });
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 60 })], user: 'trudy' });
    recordScans({ sessionId: session.id, zoneId: other.id, scans: [scan({ qty: 40 })], user: 'james' });
    expect(getZoneSummary(session.id).every((z) => z.items_also_in_another_zone === 1)).toBe(true);
    const [item] = getZoneItems({ sessionId: session.id, zoneId: zone.id });
    expect(item.other_zones).toBe('Aisle 2');
    expect(item.zone_qty).toBe(60);
  });
});

describe('recording scans', () => {
  it('counts a resent batch once, not twice', () => {
    const batch = [scan({ client_id: 'fixed-1', qty: 10 })];
    const first = recordScans({ sessionId: session.id, zoneId: zone.id, scans: batch, user: 'trudy' });
    const retry = recordScans({ sessionId: session.id, zoneId: zone.id, scans: batch, user: 'trudy' });
    expect(first.accepted_count).toBe(1);
    expect(retry.accepted_count).toBe(0);
    expect(retry.duplicate_count).toBe(1);
    expect(memDb.prepare('SELECT COUNT(*) c FROM stocktake_scan').get().c).toBe(1);
  });

  it('keeps a scan of a barcode nobody has mapped rather than dropping the count', () => {
    const r = recordScans({
      sessionId: session.id, zoneId: zone.id, user: 'trudy',
      scans: [scan({ item_number: null, unit: null, barcode: '6001111111111', qty: 3 })],
    });
    expect(r.accepted_count).toBe(1);
    expect(listUnresolvedScans(session.id)).toHaveLength(1);
  });

  it('rejects a scan with no quantity, and says why', () => {
    const r = recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 0 })], user: 'trudy' });
    expect(r.rejected_count).toBe(1);
    expect(r.rejected[0].reason).toMatch(/cannot be zero/i);
  });

  it('takes the pack size from the item list, not from the phone', () => {
    memDb.prepare("INSERT INTO stocktake_item VALUES ('110','CASE',10,'PETER BLUE 10S','CTN','20S','Cigarettes 20s','2',0,'x')").run();
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ unit: 'CASE', qty: 4 })], user: 'trudy' });
    const row = memDb.prepare('SELECT qty, conversion, stock_qty FROM stocktake_scan').get();
    expect(row).toMatchObject({ qty: 4, conversion: 10, stock_qty: 40 });
  });
});

describe('the recount rule', () => {
  it('refuses a recount by the person who counted it first', () => {
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 90 })], user: 'trudy' });
    const r = recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 100, pass: 2 })], user: 'trudy' });
    expect(r.rejected_count).toBe(1);
    expect(r.rejected[0].reason).toMatch(/has to be done by someone else/i);
  });

  it('accepts it from anyone else, and that second pass is the count', () => {
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 90 })], user: 'trudy' });
    const r = recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 100, pass: 2 })], user: 'james' });
    expect(r.accepted_count).toBe(1);
    const row = getVariance(session.id, { filter: 'all' }).rows.find((x) => x.item_number === '110');
    expect(row.counted_qty).toBe(100);
    expect(row.pass1_qty).toBe(90);
    expect(row.diff_qty).toBe(0);
    expect(row.recount_done).toBe(true);
  });
});

describe('variance', () => {
  it('adds up every scan of an item rather than replacing the last one', () => {
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 40 }), scan({ qty: 35 })], user: 'trudy' });
    const row = getVariance(session.id, { filter: 'all' }).rows.find((r) => r.item_number === '110');
    expect(row.counted_qty).toBe(75);
    expect(row.diff_qty).toBe(-25);
  });

  it('values the difference at what the stock was carried at', () => {
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 99 })], user: 'trudy' });
    const row = getVariance(session.id, { filter: 'all' }).rows.find((r) => r.item_number === '110');
    expect(row.unit_cost).toBeCloseTo(391.58, 2);
    expect(row.diff_value).toBeCloseTo(-391.58, 2);
  });

  it('shows stock that was expected but never counted — the most important line in the report', () => {
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 100 })], user: 'trudy' });
    const missing = getVariance(session.id, { filter: 'never_counted' }).rows;
    expect(missing.map((r) => r.item_number).sort()).toEqual(['4010', '9']);
  });

  it('flags an item counted in two zones instead of quietly adding it up', () => {
    const other = claimZone({ zoneId: zoneNamed(session.id, 'Aisle 2').id, user: 'james' });
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 50 })], user: 'trudy' });
    recordScans({ sessionId: session.id, zoneId: other.id, scans: [scan({ qty: 50 })], user: 'james' });
    const row = getVariance(session.id, { filter: 'all' }).rows.find((r) => r.item_number === '110');
    expect(row.counted_in_multiple_zones).toBe(true);
    expect(row.zone_count).toBe(2);
  });

  it('sends an item back for recount on either threshold', () => {
    // Item 9 is out by 3 boxes worth R30: under the R500 threshold but over
    // the 2-unit one, so it still has to be recounted.
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ item_number: '9', unit: 'BOX', qty: 2 })], user: 'trudy' });
    const names = listRecountItems(session.id).map((r) => r.item_number);
    expect(names).toContain('9');
  });

  it('leaves a scan out of the count once it is undone', () => {
    const r = recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 100 })], user: 'trudy' });
    expect(r.accepted_count).toBe(1);
    const id = memDb.prepare('SELECT id FROM stocktake_scan').get().id;
    voidScan({ scanId: id, user: 'trudy' });
    const row = getVariance(session.id, { filter: 'all' }).rows.find((x) => x.item_number === '110');
    expect(row.counted_qty).toBe(0);
    expect(row.never_counted).toBe(true);
  });
});

describe('blind counting', () => {
  it('gives a counter the item but never the quantity or the cost', () => {
    memDb.prepare("INSERT INTO item_barcode (barcode, item_number, unit) VALUES ('6001234567890','110','CTN')").run();
    const r = resolveForCount({ barcode: '6001234567890' });
    expect(r).toMatchObject({ found: true, item_number: '110', unit: 'CTN' });
    expect(Object.keys(r)).not.toContain('qty_on_hand');
    expect(Object.keys(r)).not.toContain('average_cost');
  });

  it('gives the recount list without saying how many are expected', () => {
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 50 })], user: 'trudy' });
    const [item] = listRecountItems(session.id).filter((r) => r.item_number === '110');
    expect(item.first_counted_by).toBe('trudy');
    expect(Object.keys(item)).not.toContain('expected_qty');
    expect(Object.keys(item)).not.toContain('counted_qty');
  });
});

describe('closing', () => {
  it('will not close over an outstanding recount without being told twice', () => {
    recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan({ qty: 50 })], user: 'trudy' });
    submitZone({ zoneId: zone.id, user: 'trudy' });
    expect(() => closeSession({ id: session.id, user: 'sean' })).toThrowError(/not finished/i);
    const closed = closeSession({ id: session.id, user: 'sean', force: true });
    expect(closed.status).toBe('closed');
    expect(closed.notes).toMatch(/awaiting recount/i);
  });

  it('locks the count once it is closed', () => {
    submitZone({ zoneId: zone.id, user: 'trudy' });
    closeSession({ id: session.id, user: 'sean', force: true });
    expect(() => recordScans({ sessionId: session.id, zoneId: zone.id, scans: [scan()], user: 'trudy' }))
      .toThrowError(/is closed/i);
  });
});

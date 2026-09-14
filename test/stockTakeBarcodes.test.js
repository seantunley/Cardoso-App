// Stock take barcode map — the parts that are wrong silently if they break.
//
// The one that matters most: a UPC-A label read by a phone camera comes back as
// 12 digits, and the SAME label read by a laser scanner comes back as 13 with a
// leading zero. If those two do not resolve to the same mapping, the second
// device calls a mapped item "unknown" and a counter maps it a second time —
// and then the two devices count the same shelf under two different items.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => '2026-09-14 08:00:00');
memDb.exec(`
  CREATE TABLE stocktake_item (
    item_number TEXT NOT NULL, unit TEXT NOT NULL, conversion REAL NOT NULL DEFAULT 1,
    item_description TEXT, stock_unit TEXT, category TEXT,
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
`);

vi.mock('../src/db/index.js', () => ({ default: memDb }));
// The Sage pool and the error log are not exercised here and both drag in the
// real database at import time.
vi.mock('../src/services/batReconciliation.js', () => ({ getSagePool: vi.fn() }));
vi.mock('../src/lib/errorLog.js', () => ({ logError: vi.fn() }));

const { normaliseBarcode, barcodeVariants, lookupBarcode, saveBarcode, deleteBarcode } =
  await import('../src/services/stockTake.js');

beforeEach(() => {
  memDb.exec('DELETE FROM item_barcode; DELETE FROM stocktake_item; DELETE FROM inventory_location_onhand;');
  memDb.prepare("INSERT INTO stocktake_item VALUES ('110','EACH',1,'WINSTON RED 20s','EACH','20S',0,'x')").run();
  memDb.prepare("INSERT INTO stocktake_item VALUES ('110','CARTON',10,'WINSTON RED 20s','EACH','20S',0,'x')").run();
  memDb.prepare("INSERT INTO inventory_location_onhand VALUES ('110','POL',250,97894.90,'x')").run();
});

describe('normaliseBarcode', () => {
  it('strips the Enter and stray whitespace a wedge scanner appends', () => {
    expect(normaliseBarcode('6001234567890\r\n')).toBe('6001234567890');
    expect(normaliseBarcode('  600 123 456 7890 ')).toBe('6001234567890');
  });

  it('rejects what is plainly not a barcode', () => {
    expect(normaliseBarcode('')).toBe('');
    expect(normaliseBarcode('12')).toBe('');
    expect(normaliseBarcode('x'.repeat(49))).toBe('');
  });

  it('leaves the case of alphanumeric symbologies alone', () => {
    // Code 39 and Code 128 are case-sensitive; folding case would merge two
    // genuinely different labels.
    expect(normaliseBarcode('AB-1234c')).toBe('AB-1234c');
  });
});

describe('barcodeVariants', () => {
  it('treats UPC-A and its zero-padded EAN-13 form as the same label', () => {
    expect(barcodeVariants('012345678905')).toContain('0012345678905');
    expect(barcodeVariants('0012345678905')).toContain('012345678905');
  });

  it('never pads EAN-8 or EAN-13, which are different numbers', () => {
    expect(barcodeVariants('96385074')).toEqual(['96385074']);
    expect(barcodeVariants('6001234567890')).toEqual(['6001234567890']);
  });
});

describe('the map', () => {
  it('finds a barcode mapped in the other UPC/EAN form', () => {
    saveBarcode({ barcode: '012345678905', itemNumber: '110', unit: 'CARTON', user: 'trudy' });
    const viaScanner = lookupBarcode({ barcode: '0012345678905', location: 'POL' });
    expect(viaScanner.found).toBe(true);
    expect(viaScanner.item_number).toBe('110');
    expect(viaScanner.unit).toBe('CARTON');
  });

  it('will not map the same label twice under its other form', () => {
    saveBarcode({ barcode: '012345678905', itemNumber: '110', unit: 'CARTON', user: 'trudy' });
    expect(() => saveBarcode({ barcode: '0012345678905', itemNumber: '110', unit: 'EACH', user: 'sean' }))
      .toThrowError(/already mapped/i);
    expect(memDb.prepare('SELECT COUNT(*) c FROM item_barcode').get().c).toBe(1);
  });

  it('re-points an existing barcode only when that is confirmed', () => {
    const first = saveBarcode({ barcode: '6001234567890', itemNumber: '110', unit: 'EACH', user: 'trudy' });
    const again = saveBarcode({ barcode: '6001234567890', itemNumber: '110', unit: 'CARTON', user: 'sean', allowRemap: true });
    expect(again.remapped).toBe(true);
    expect(again.id).toBe(first.id);
    expect(lookupBarcode({ barcode: '6001234567890' }).unit).toBe('CARTON');
  });

  it('refuses a unit Sage does not have for that item', () => {
    expect(() => saveBarcode({ barcode: '6001234567890', itemNumber: '110', unit: 'PALLET', user: 'sean' }))
      .toThrowError(/does not list the unit/i);
  });

  it('shows on-hand in the scanned pack size, not just the stocking unit', () => {
    // 250 EACH on hand; a carton is 10, so the person holding a carton sees 25.
    saveBarcode({ barcode: '6001234567890', itemNumber: '110', unit: 'CARTON', user: 'trudy' });
    const r = lookupBarcode({ barcode: '6001234567890', location: 'POL' });
    expect(r.qty_on_hand).toBe(250);
    expect(r.qty_on_hand_in_unit).toBe(25);
    expect(r.average_cost).toBeCloseTo(391.5796, 4);
  });

  it('says so out loud when the mapped unit has vanished from Sage', () => {
    saveBarcode({ barcode: '6001234567890', itemNumber: '110', unit: 'CARTON', user: 'trudy' });
    memDb.prepare("DELETE FROM stocktake_item WHERE item_number='110' AND unit='CARTON'").run();
    const r = lookupBarcode({ barcode: '6001234567890', location: 'POL' });
    expect(r.found).toBe(true);
    expect(r.unit_missing_in_sage).toBe(true);
    expect(r.unit_warning).toMatch(/no longer lists/i);
  });

  it('reports an unmapped barcode as a normal state, not an error', () => {
    const r = lookupBarcode({ barcode: '6009999999999', location: 'POL' });
    expect(r.found).toBe(false);
    expect(r.reason).toBe('unmapped');
  });

  it('returns the removed row so the deletion can be audited', () => {
    const saved = saveBarcode({ barcode: '6001234567890', itemNumber: '110', unit: 'EACH', user: 'trudy' });
    expect(deleteBarcode(saved.id)).toMatchObject({ barcode: '6001234567890', item_number: '110', unit: 'EACH' });
    expect(deleteBarcode(saved.id)).toBeNull();
  });
});

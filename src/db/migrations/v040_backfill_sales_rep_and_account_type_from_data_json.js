import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 40,
      name: 'backfill_sales_rep_and_account_type_from_data_json',
      up(db) {
        const salesRepAliases = [
          'sales_rep', 'SalesRep', 'SALEREP', 'SalesRepCode', 'salesrep', 'SalesPerson', 'SalesPersonCode',
          'Sales Rep', 'Sales Rep Code', 'SalesRepName', 'SalesPersonName', 'Salesman', 'SalesmanCode',
          'SalesmanName', 'Rep', 'RepCode', 'RepName', 'sales_rep_name', 'salesperson_name', 'salesman_name'
        ];
        const accountTypeAliases = [
          'account_type', 'AccountType', 'ACCOUNT_TYPE', 'accounttype', 'Type', 'CUSTOMER_TYPE',
          'CustomerType', 'customer_type', 'Class', 'CustomerClass', 'Account Type'
        ];

        const getFirstValue = (row, aliases) => {
          for (const key of aliases) {
            const value = row?.[key];
            if (value !== undefined && value !== null && String(value).trim() !== '') {
              return String(value);
            }
          }
          return null;
        };

        const updateDatarecord = db.prepare(`
          UPDATE datarecord
          SET sales_rep = COALESCE(?, sales_rep),
              account_type = COALESCE(?, account_type),
              updated_date = ?
          WHERE id = ?
        `);

        const rows = db.prepare(`
          SELECT id, data, sales_rep, account_type
          FROM datarecord
          WHERE (sales_rep IS NULL OR TRIM(sales_rep) = '')
             OR (account_type IS NULL OR TRIM(account_type) = '')
        `).all();

        const now = new Date().toISOString();
        const runBackfill = db.transaction((records) => {
          for (const record of records) {
            let parsed;
            try {
              parsed = record.data ? JSON.parse(record.data) : null;
            } catch {
              parsed = null;
            }
            if (!parsed || typeof parsed !== 'object') continue;

            const nextSalesRep = (!record.sales_rep || String(record.sales_rep).trim() === '')
              ? getFirstValue(parsed, salesRepAliases)
              : null;
            const nextAccountType = (!record.account_type || String(record.account_type).trim() === '')
              ? getFirstValue(parsed, accountTypeAliases)
              : null;

            if (!nextSalesRep && !nextAccountType) continue;

            updateDatarecord.run(nextSalesRep, nextAccountType, now, record.id);
          }
        });

        runBackfill(rows);
      },
    };

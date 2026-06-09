WITH CustomerBase AS
(
    SELECT
        LTRIM(RTRIM(c.IDCUST)) AS IDCUST,
        c.NAMECUST,
        c.CODESLSP1,
        LTRIM(RTRIM(c.CODETERM)) AS terms,
        LTRIM(RTRIM(c.LOCATION)) AS location,
        c.DATELASTIV,
        c.DATELASTPA,
        NULLIF(LTRIM(RTRIM(c.IDNATACCT)), '') AS IDNATACCT
    FROM ARCUS c
),

-- Balance = OPEN ITEMS (AROBL), the source of truth (not the drifted master
-- AMTBALDUEH). Each open document is grouped by its REPORTING ACCOUNT — the
-- national account when the customer is a member, otherwise the customer's own
-- code. Summing this reconciles to the Sage Aged Trial Balance total to the
-- cent, with national families correctly rolled up.
OpenByReporting AS
(
    -- open_balance + Sage Aged-Trial-Balance buckets (by DOCUMENT date, as of
    -- sync time). Buckets always sum to open_balance, so the on-screen aging
    -- tiles reconcile to the balance by construction. Undated docs -> Current.
    SELECT
        z.reporting_account,
        SUM(z.AMTDUEHC)                                                       AS open_balance,
        SUM(CASE WHEN z.age IS NULL OR z.age <= 0 THEN z.AMTDUEHC ELSE 0 END) AS age_current,
        SUM(CASE WHEN z.age BETWEEN 1  AND 7  THEN z.AMTDUEHC ELSE 0 END)     AS age_1_7,
        SUM(CASE WHEN z.age BETWEEN 8  AND 14 THEN z.AMTDUEHC ELSE 0 END)     AS age_8_14,
        SUM(CASE WHEN z.age BETWEEN 15 AND 21 THEN z.AMTDUEHC ELSE 0 END)     AS age_15_21,
        SUM(CASE WHEN z.age > 21              THEN z.AMTDUEHC ELSE 0 END)     AS age_over_21
    FROM
    (
        SELECT
            CASE WHEN NULLIF(LTRIM(RTRIM(c.IDNATACCT)), '') IS NOT NULL
                 THEN LTRIM(RTRIM(c.IDNATACCT))
                 ELSE LTRIM(RTRIM(o.IDCUST)) END   AS reporting_account,
            o.AMTDUEHC,
            DATEDIFF(day, CONVERT(date, CAST(NULLIF(o.DATEINVC, 0) AS varchar(8)), 112), CAST(GETDATE() AS date)) AS age
        FROM AROBL o
        INNER JOIN ARCUS c ON LTRIM(RTRIM(c.IDCUST)) = LTRIM(RTRIM(o.IDCUST))
        WHERE o.AMTDUEHC <> 0
    ) z
    GROUP BY z.reporting_account
),

NationalFamilies AS
(
    -- A national account is only REAL if customers actually reference it via
    -- ARCUS.IDNATACCT. ARNAT holds 1315 zero-member definitions that would
    -- otherwise tag standalone customers (e.g. 6013 ENGEN UNCLE HARRY) as
    -- NATIONAL_ACCOUNT. Source the families from the membership, not ARNAT.
    SELECT DISTINCT
        LTRIM(RTRIM(c.IDNATACCT)) AS reporting_account
    FROM ARCUS c
    WHERE LTRIM(RTRIM(c.IDNATACCT)) <> ''
),

-- NATIONAL ACCOUNT ROWS: one per national account from ARNAT
SyntheticNationalRows AS
(
    SELECT
        nf.reporting_account                            AS customer_number,
        COALESCE(
            ac.NAMECUST,
            (
                SELECT TOP 1 child.NAMECUST
                FROM CustomerBase child
                WHERE child.IDNATACCT = nf.reporting_account
                  AND child.IDCUST <> nf.reporting_account
                ORDER BY child.IDCUST
            ),
            nf.reporting_account
        )                                               AS customer_name,
        COALESCE(
            ac.CODESLSP1,
            (
                SELECT TOP 1 child.CODESLSP1
                FROM CustomerBase child
                WHERE child.IDNATACCT = nf.reporting_account
                  AND child.IDCUST <> nf.reporting_account
                ORDER BY child.IDCUST
            )
        )                                               AS salesperson_code,
        LTRIM(RTRIM(ac.CODETERM))                       AS terms,
        LTRIM(RTRIM(ac.LOCATION))                       AS location,
        'NATIONAL_ACCOUNT'                              AS account_type,
        nf.reporting_account                            AS linked_national_account,
        nf.reporting_account                            AS reporting_account,
        ISNULL(obr.open_balance, 0)                         AS outstanding_balance,
        ISNULL(obr.age_current, 0)                          AS age_current,
        ISNULL(obr.age_1_7, 0)                              AS age_1_7,
        ISNULL(obr.age_8_14, 0)                             AS age_8_14,
        ISNULL(obr.age_15_21, 0)                            AS age_15_21,
        ISNULL(obr.age_over_21, 0)                          AS age_over_21,
        (
            SELECT MAX(child.DATELASTIV)
            FROM CustomerBase child
            WHERE child.IDNATACCT = nf.reporting_account
        )                                               AS LastInvoiceDate,
        (
            SELECT MAX(child.DATELASTPA)
            FROM CustomerBase child
            WHERE child.IDNATACCT = nf.reporting_account
        )                                               AS LastReceiptDate
    FROM NationalFamilies nf
    LEFT JOIN ARCUS ac
        ON LTRIM(RTRIM(ac.IDCUST)) = nf.reporting_account
    LEFT JOIN OpenByReporting obr
        ON obr.reporting_account = nf.reporting_account
),

-- STANDARD ROWS: accounts that are NOT children and NOT national accounts
-- A child = IDNATACCT is populated (and different from IDCUST, or same - doesn't matter, they're linked)
-- A national account = exists in ARNAT
-- Standard = neither
StandardRows AS
(
    SELECT
        cb.IDCUST                   AS customer_number,
        cb.NAMECUST                 AS customer_name,
        cb.CODESLSP1                AS salesperson_code,
        cb.terms                    AS terms,
        cb.location                 AS location,
        'STANDARD'                  AS account_type,
        CAST(NULL AS VARCHAR(24))   AS linked_national_account,
        cb.IDCUST                   AS reporting_account,
        ISNULL(obr.open_balance, 0) AS outstanding_balance,
        ISNULL(obr.age_current, 0)  AS age_current,
        ISNULL(obr.age_1_7, 0)      AS age_1_7,
        ISNULL(obr.age_8_14, 0)     AS age_8_14,
        ISNULL(obr.age_15_21, 0)    AS age_15_21,
        ISNULL(obr.age_over_21, 0)  AS age_over_21,
        cb.DATELASTIV               AS LastInvoiceDate,
        cb.DATELASTPA               AS LastReceiptDate
    FROM CustomerBase cb
    LEFT JOIN OpenByReporting obr
        ON obr.reporting_account = cb.IDCUST
    WHERE cb.IDNATACCT IS NULL
      AND NOT EXISTS
      (
          SELECT 1 FROM NationalFamilies nf
          WHERE nf.reporting_account = cb.IDCUST
      )
),

-- National accounts FIRST so they appear in results even with row limits
DisplayRows AS
(
    SELECT
        snr.customer_number,
        snr.customer_name,
        snr.salesperson_code,
        snr.terms,
        snr.location,
        snr.account_type,
        snr.linked_national_account,
        snr.reporting_account,
        snr.outstanding_balance,
        snr.age_current,
        snr.age_1_7,
        snr.age_8_14,
        snr.age_15_21,
        snr.age_over_21,
        snr.LastInvoiceDate,
        snr.LastReceiptDate
    FROM SyntheticNationalRows snr

    UNION ALL

    SELECT * FROM StandardRows
),

InvoiceSource AS
(
    SELECT
        CASE
            WHEN cb.IDNATACCT IS NOT NULL THEN cb.IDNATACCT
            ELSE cb.IDCUST
        END                             AS reporting_account,
        o.IDINVC,
        o.DATEINVC,
        ISNULL(o.AMTDUEHC, 0)          AS InvoiceAmount   -- OUTSTANDING, not original
    FROM AROBL o
    INNER JOIN CustomerBase cb
        ON cb.IDCUST = LTRIM(RTRIM(o.IDCUST))
    WHERE ISNULL(o.IDINVC, '') <> ''
      AND o.AMTDUEHC > 0.02   -- open CHARGES (by sign, not prefix); R0.02 rounding tolerance
),

InvoiceGrouped AS
(
    SELECT
        reporting_account,
        IDINVC,
        DATEINVC,
        SUM(InvoiceAmount) AS InvoiceAmount
    FROM InvoiceSource
    GROUP BY
        reporting_account,
        IDINVC,
        DATEINVC
),

RankedInvoices AS
(
    SELECT
        reporting_account,
        IDINVC,
        DATEINVC,
        InvoiceAmount,
        ROW_NUMBER() OVER
        (
            PARTITION BY reporting_account
            ORDER BY DATEINVC DESC, IDINVC DESC
        ) AS rn
    FROM InvoiceGrouped
),

ReceiptSource AS
(
    SELECT
        CASE
            WHEN cb.IDNATACCT IS NOT NULL THEN cb.IDNATACCT
            ELSE cb.IDCUST
        END                             AS reporting_account,
        o.IDINVC                        AS ReceiptNumber,
        o.DATEINVC                      AS ReceiptDate,
        ISNULL(o.AMTDUEHC, 0)          AS ReceiptAmount   -- UNAPPLIED portion
    FROM AROBL o
    INNER JOIN CustomerBase cb
        ON cb.IDCUST = LTRIM(RTRIM(o.IDCUST))
    WHERE ISNULL(o.IDINVC, '') <> ''
      AND o.AMTDUEHC < -0.02   -- open CREDITS (payments/unapplied cash/credit notes); R0.02 tolerance
),

ReceiptGrouped AS
(
    SELECT
        reporting_account,
        ReceiptNumber,
        ReceiptDate,
        SUM(ReceiptAmount) AS ReceiptAmount
    FROM ReceiptSource
    GROUP BY
        reporting_account,
        ReceiptNumber,
        ReceiptDate
),

RankedReceipts AS
(
    SELECT
        reporting_account,
        ReceiptNumber,
        ReceiptDate,
        ReceiptAmount,
        ROW_NUMBER() OVER
        (
            PARTITION BY reporting_account
            ORDER BY ReceiptDate DESC, ReceiptNumber DESC
        ) AS rn
    FROM ReceiptGrouped
),

InvoicePivot AS
(
    SELECT
        reporting_account,

        MAX(CASE WHEN rn = 1 THEN IDINVC END)        AS LastInvoice1Number,
        MAX(CASE WHEN rn = 1 THEN DATEINVC END)      AS LastInvoice1Date,
        MAX(CASE WHEN rn = 1 THEN InvoiceAmount END)  AS LastInvoice1Amount,

        MAX(CASE WHEN rn = 2 THEN IDINVC END)        AS LastInvoice2Number,
        MAX(CASE WHEN rn = 2 THEN DATEINVC END)      AS LastInvoice2Date,
        MAX(CASE WHEN rn = 2 THEN InvoiceAmount END)  AS LastInvoice2Amount,

        MAX(CASE WHEN rn = 3 THEN IDINVC END)        AS LastInvoice3Number,
        MAX(CASE WHEN rn = 3 THEN DATEINVC END)      AS LastInvoice3Date,
        MAX(CASE WHEN rn = 3 THEN InvoiceAmount END)  AS LastInvoice3Amount,

        MAX(CASE WHEN rn = 4 THEN IDINVC END)        AS LastInvoice4Number,
        MAX(CASE WHEN rn = 4 THEN DATEINVC END)      AS LastInvoice4Date,
        MAX(CASE WHEN rn = 4 THEN InvoiceAmount END)  AS LastInvoice4Amount,

        MAX(CASE WHEN rn = 5 THEN IDINVC END)        AS LastInvoice5Number,
        MAX(CASE WHEN rn = 5 THEN DATEINVC END)      AS LastInvoice5Date,
        MAX(CASE WHEN rn = 5 THEN InvoiceAmount END)  AS LastInvoice5Amount
    FROM RankedInvoices
    WHERE rn <= 5
    GROUP BY reporting_account
),

ReceiptPivot AS
(
    SELECT
        reporting_account,

        MAX(CASE WHEN rn = 1 THEN ReceiptNumber END)  AS LastReceipt1Number,
        MAX(CASE WHEN rn = 1 THEN ReceiptDate END)    AS LastReceipt1Date,
        MAX(CASE WHEN rn = 1 THEN ReceiptAmount END)  AS LastReceipt1Amount,

        MAX(CASE WHEN rn = 2 THEN ReceiptNumber END)  AS LastReceipt2Number,
        MAX(CASE WHEN rn = 2 THEN ReceiptDate END)    AS LastReceipt2Date,
        MAX(CASE WHEN rn = 2 THEN ReceiptAmount END)  AS LastReceipt2Amount,

        MAX(CASE WHEN rn = 3 THEN ReceiptNumber END)  AS LastReceipt3Number,
        MAX(CASE WHEN rn = 3 THEN ReceiptDate END)    AS LastReceipt3Date,
        MAX(CASE WHEN rn = 3 THEN ReceiptAmount END)  AS LastReceipt3Amount,

        MAX(CASE WHEN rn = 4 THEN ReceiptNumber END)  AS LastReceipt4Number,
        MAX(CASE WHEN rn = 4 THEN ReceiptDate END)    AS LastReceipt4Date,
        MAX(CASE WHEN rn = 4 THEN ReceiptAmount END)  AS LastReceipt4Amount,

        MAX(CASE WHEN rn = 5 THEN ReceiptNumber END)  AS LastReceipt5Number,
        MAX(CASE WHEN rn = 5 THEN ReceiptDate END)    AS LastReceipt5Date,
        MAX(CASE WHEN rn = 5 THEN ReceiptAmount END)  AS LastReceipt5Amount
    FROM RankedReceipts
    WHERE rn <= 5
    GROUP BY reporting_account
)

SELECT
    dr.customer_number,
    dr.customer_name,
    dr.salesperson_code,
    dr.terms,
    dr.location,
    dr.account_type,
    dr.linked_national_account,
    dr.outstanding_balance,
    dr.age_current,
    dr.age_1_7,
    dr.age_8_14,
    dr.age_15_21,
    dr.age_over_21,
    dr.LastInvoiceDate,
    dr.LastReceiptDate,

    ip.LastInvoice1Number   AS last_unpaid_invoice_1,
    ip.LastInvoice1Date     AS last_unpaid_invoice_1_date,
    ip.LastInvoice1Amount   AS last_unpaid_invoice_1_amount,
    ip.LastInvoice2Number   AS last_unpaid_invoice_2,
    ip.LastInvoice2Date     AS last_unpaid_invoice_2_date,
    ip.LastInvoice2Amount   AS last_unpaid_invoice_2_amount,
    ip.LastInvoice3Number   AS last_unpaid_invoice_3,
    ip.LastInvoice3Date     AS last_unpaid_invoice_3_date,
    ip.LastInvoice3Amount   AS last_unpaid_invoice_3_amount,
    ip.LastInvoice4Number   AS last_unpaid_invoice_4,
    ip.LastInvoice4Date     AS last_unpaid_invoice_4_date,
    ip.LastInvoice4Amount   AS last_unpaid_invoice_4_amount,
    ip.LastInvoice5Number   AS last_unpaid_invoice_5,
    ip.LastInvoice5Date     AS last_unpaid_invoice_5_date,
    ip.LastInvoice5Amount   AS last_unpaid_invoice_5_amount,

    rp.LastReceipt1Number   AS last_receipt_1,
    rp.LastReceipt1Date     AS last_receipt_1_date,
    rp.LastReceipt1Amount   AS last_receipt_1_amount,
    rp.LastReceipt2Number   AS last_receipt_2,
    rp.LastReceipt2Date     AS last_receipt_2_date,
    rp.LastReceipt2Amount   AS last_receipt_2_amount,
    rp.LastReceipt3Number   AS last_receipt_3,
    rp.LastReceipt3Date     AS last_receipt_3_date,
    rp.LastReceipt3Amount   AS last_receipt_3_amount,
    rp.LastReceipt4Number   AS last_receipt_4,
    rp.LastReceipt4Date     AS last_receipt_4_date,
    rp.LastReceipt4Amount   AS last_receipt_4_amount,
    rp.LastReceipt5Number   AS last_receipt_5,
    rp.LastReceipt5Date     AS last_receipt_5_date,
    rp.LastReceipt5Amount   AS last_receipt_5_amount

FROM DisplayRows dr
LEFT JOIN InvoicePivot ip
    ON ip.reporting_account = dr.reporting_account
LEFT JOIN ReceiptPivot rp
    ON rp.reporting_account = dr.reporting_account
ORDER BY dr.account_type DESC, dr.customer_number;
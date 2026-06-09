WITH CustomerBase AS
(
    SELECT
        LTRIM(RTRIM(c.IDCUST)) AS IDCUST,
        c.NAMECUST,
        c.CODESLSP1,
        ISNULL(c.AMTBALDUEH, 0) AS AMTBALDUEH,
        c.DATELASTIV,
        c.DATELASTPA,
        NULLIF(LTRIM(RTRIM(c.IDNATACCT)), '') AS IDNATACCT
    FROM ARCUS c
),

NationalFamilies AS
(
    SELECT DISTINCT
        LTRIM(RTRIM(n.IDNATACCT)) AS reporting_account
    FROM ARNAT n
    WHERE LTRIM(RTRIM(n.IDNATACCT)) <> ''
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
        'NATIONAL_ACCOUNT'                              AS account_type,
        nf.reporting_account                            AS linked_national_account,
        nf.reporting_account                            AS reporting_account,
        ISNULL(
            (
                SELECT SUM(ISNULL(child.AMTBALDUEH, 0))
                FROM CustomerBase child
                WHERE child.IDNATACCT = nf.reporting_account
            ), 0
        )                                                   AS outstanding_balance,
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
        'STANDARD'                  AS account_type,
        CAST(NULL AS VARCHAR(24))   AS linked_national_account,
        cb.IDCUST                   AS reporting_account,
        cb.AMTBALDUEH               AS outstanding_balance,
        cb.DATELASTIV               AS LastInvoiceDate,
        cb.DATELASTPA               AS LastReceiptDate
    FROM CustomerBase cb
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
        snr.account_type,
        snr.linked_national_account,
        snr.reporting_account,
        snr.outstanding_balance,
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
        ISNULL(o.AMTINVCHC, 0)         AS InvoiceAmount
    FROM AROBL o
    INNER JOIN CustomerBase cb
        ON cb.IDCUST = LTRIM(RTRIM(o.IDCUST))
    WHERE ISNULL(o.IDINVC, '') <> ''
      AND o.IDINVC LIKE 'IN%'
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
        ISNULL(o.AMTINVCHC, 0)         AS ReceiptAmount
    FROM AROBL o
    INNER JOIN CustomerBase cb
        ON cb.IDCUST = LTRIM(RTRIM(o.IDCUST))
    WHERE ISNULL(o.IDINVC, '') <> ''
      AND o.IDINVC LIKE 'PY%'
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
    dr.account_type,
    dr.linked_national_account,
    dr.outstanding_balance,
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
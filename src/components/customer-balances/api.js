import { parseAmount } from "./utils";

// Fetch a single page of top balances. Used both for the on-screen
// virtualised table (one page = PAGE_SIZE rows) and as a building block
// for fetchAllTopBalances() below.
/** @returns {Promise<import('@/types/api-rows').TopBalancesResponse>} */
export async function fetchTopBalances({ page, limit, siteFilter, ageBucket, salesRepFilter, hideInvoiceMatchesBalance, lastPurchaseDays, dormantOnly, accountType, minBalance }) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  if (siteFilter && siteFilter !== "all") params.set("site", siteFilter);
  if (ageBucket && ageBucket !== "all") params.set("ageBucket", ageBucket);
  if (salesRepFilter && salesRepFilter !== "all") params.set("salesRep", salesRepFilter);
  if (hideInvoiceMatchesBalance) params.set("hideInvoiceMatchesBalance", "1");
  if (lastPurchaseDays && lastPurchaseDays !== "all") params.set("lastPurchaseDays", String(lastPurchaseDays));
  if (dormantOnly) params.set("dormantOnly", "1");
  if (accountType && accountType !== "all") params.set("accountType", accountType);
  // Always sent when set (including "0" to turn the floor off) so the server
  // doesn't fall back to its R3 default when the operator clears the filter.
  if (minBalance !== undefined && minBalance !== null && minBalance !== "") params.set("min_balance", String(minBalance));

  const res = await fetch(`/api/top-balances?${params.toString()}`, { credentials: "include" });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || "Failed to load balances");
  }
  const data = await res.json();
  // Handle both old servers (array) and new servers (paginated object)
  if (Array.isArray(data)) {
    const pageTotalOutstanding = data.reduce((sum, row) => sum + parseAmount(row.outstanding_balance), 0);
    return {
      records: data,
      total: data.length,
      page,
      limit,
      totalPages: 1,
      filteredTotalOutstanding: pageTotalOutstanding,
      pageTotalOutstanding,
      sites: [...new Set(data.map((row) => row.site_name).filter(Boolean))].sort(),
      minBalanceThreshold: 0,
    };
  }
  return data;
}

// Fetch every page sequentially so the print view sees the full set
// (the screen view caps at PAGE_SIZE). Only triggered when totalRecords
// exceeds PAGE_SIZE, gated by the printData useQuery's `enabled`.
/** @returns {Promise<import('@/types/api-rows').TopBalancesResponse>} */
export async function fetchAllTopBalances({ siteFilter, ageBucket, salesRepFilter, hideInvoiceMatchesBalance, lastPurchaseDays, dormantOnly, accountType, minBalance }) {
  const firstPage = await fetchTopBalances({
    page: 1,
    limit: 200,
    siteFilter,
    ageBucket,
    salesRepFilter,
    hideInvoiceMatchesBalance,
    lastPurchaseDays,
    dormantOnly,
    accountType,
    minBalance,
  });

  if ((firstPage?.totalPages ?? 1) <= 1) return firstPage;

  const allRecords = [...(firstPage.records ?? [])];
  for (let nextPage = 2; nextPage <= firstPage.totalPages; nextPage += 1) {
    const pageData = await fetchTopBalances({
      page: nextPage,
      limit: 200,
      siteFilter,
      ageBucket,
      salesRepFilter,
      hideInvoiceMatchesBalance,
      lastPurchaseDays,
      dormantOnly,
      accountType,
      minBalance,
    });
    allRecords.push(...(pageData.records ?? []));
  }

  return {
    ...firstPage,
    records: allRecords,
    page: 1,
    pageTotalOutstanding:
      firstPage.filteredTotalOutstanding ??
      allRecords.reduce((sum, row) => sum + parseAmount(row.outstanding_balance), 0),
  };
}

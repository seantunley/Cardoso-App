import { QueryClient } from '@tanstack/react-query';


export const queryClientInstance = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			retry: 1,
			staleTime: 30_000, // data stays fresh for 30s — prevents redundant refetches on tab/page switches
		},
	},
});
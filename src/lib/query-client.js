import { QueryClient } from '@tanstack/react-query';


export const queryClientInstance = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			retry: 1,
			staleTime: 300_000, // data stays fresh for 5 minutes — prevents redundant refetches on tab/page switches
		},
	},
});
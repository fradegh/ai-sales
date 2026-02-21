import { useQuery } from "@tanstack/react-query";

interface FlagCheckResponse {
  name: string;
  enabled: boolean;
}

export function useAutoPartsEnabled(): boolean {
  const { data } = useQuery<FlagCheckResponse>({
    queryKey: ["/api/feature-flags/AUTO_PARTS_ENABLED/check"],
    staleTime: 5 * 60 * 1000,
  });

  return data?.enabled ?? false;
}

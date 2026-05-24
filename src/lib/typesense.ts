import Typesense from "typesense";

if (!process.env.TYPESENSE_HOST || !process.env.TYPESENSE_API_KEY) {
  throw new Error(
    "TYPESENSE_HOST and TYPESENSE_API_KEY must be defined in environment variables"
  );
}

export const typesenseClient = new Typesense.Client({
  nodes: [
    {
      host: process.env.TYPESENSE_HOST,
      port: 443,
      protocol: "https",
    },
  ],
  apiKey: process.env.TYPESENSE_API_KEY,
  connectionTimeoutSeconds: 2,
});

// Search-only client for client-side usage
export const typesenseSearchConfig = {
  host: process.env.TYPESENSE_HOST,
  apiKey: process.env.NEXT_PUBLIC_TYPESENSE_SEARCH_KEY || "",
  protocol: "https" as const,
  port: 443,
};

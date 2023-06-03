import { config as cfg } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

const config = cfg({ safe: true });

export default config as {
  RAPIDAPI_KEY: string;
  RAPIDAPI_HOST: string;
};

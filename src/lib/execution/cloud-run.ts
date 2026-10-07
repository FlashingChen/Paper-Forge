import { GoogleAuth } from "google-auth-library";
import { readManifest, runToken } from "./store";

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

export function cloudRunConfig() {
  const resource = process.env.PAPERFORGE_CLOUD_RUN_JOB ?? "";
  if (!/^projects\/[a-zA-Z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+$/.test(resource)) {
    throw new Error("PAPERFORGE_CLOUD_RUN_JOB must be projects/PROJECT/locations/REGION/jobs/JOB");
  }
  const url = new URL(process.env.PAPERFORGE_CONTROL_URL ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("PAPERFORGE_CONTROL_URL must be an HTTPS origin");
  }
  // Validate the execution secret before accepting any upload.
  runToken("configuration-check");
  return { resource, origin: url.origin };
}

export async function googleRequest<T>(resource: string, body?: unknown): Promise<T> {
  if (!/^projects\/[a-zA-Z0-9-]+\/locations\/[a-z0-9-]+\/(jobs|operations)\//.test(resource)) {
    throw new Error("Invalid Google resource");
  }
  const client = await auth.getClient();
  const response = await client.request<T>({
    url: `https://run.googleapis.com/v2/${resource}`,
    method: body === undefined ? "GET" : "POST", data: body,
    timeout: 30_000,
    // A retried jobs.run can create another execution; the durable outbox owns retries.
    retry: false,
  });
  return response.data;
}

export interface RunOperation {
  name: string;
  done?: boolean;
  error?: { message?: string };
  metadata?: { name?: string };
  response?: { name?: string; completionTime?: string; failedCount?: number; cancelledCount?: number };
}

export async function dispatchRun(id: string): Promise<RunOperation> {
  const { resource, origin } = cloudRunConfig();
  return googleRequest<RunOperation>(`${resource}:run`, {
    overrides: { taskCount: 1, timeout: `${Math.ceil(readManifest(id).timeoutMs / 1000) + 1200}s`, containerOverrides: [{
      env: [
        { name: "PAPERFORGE_JOB_ID", value: id },
        { name: "PAPERFORGE_CONTROL_URL", value: origin },
        { name: "PAPERFORGE_RUN_TOKEN", value: runToken(id) },
      ],
    }] },
  });
}

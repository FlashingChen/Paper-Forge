import http from "node:http";
export class DockerClient {
  private version?: string;
  constructor(private socketPath = "/var/run/docker.sock") {}
  async request<T>(method: string, route: string, payload?: unknown): Promise<T> {
    if (!this.version) {
      const info = await this.raw<{ ApiVersion: string }>("GET", "/version");
      if (!/^1\.\d+$/.test(info.ApiVersion) || Number(info.ApiVersion.split(".")[1]) < 41) throw new Error("Docker Engine API 1.41+ required");
      this.version = info.ApiVersion;
    }
    return this.raw(method, `/v${this.version}${route}`, payload);
  }
  private async raw<T>(method: string, route: string, payload?: unknown): Promise<T> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, method, path: route,
        headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 300) { reject(new Error(`Docker HTTP ${res.statusCode}`)); return; }
          const data = Buffer.concat(chunks).toString();
          try { resolve(data ? JSON.parse(data) : undefined); } catch { reject(new Error("Invalid Docker response")); }
        });
        res.on("error", reject);
      });
      req.setTimeout(30_000, () => req.destroy(new Error("Docker request timed out")));
      req.on("error", reject);
      req.end(body);
    });
  }
}

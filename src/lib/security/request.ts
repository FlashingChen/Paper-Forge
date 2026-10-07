export class RequestRejected extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function readLimitedBody(request: Request, limit: number): Promise<Buffer> {
  const announced=request.headers.get("content-length");
  if (announced && (!/^\d+$/.test(announced)||Number(announced)>limit)) throw new RequestRejected(413,"请求内容过大");
  const reader=request.body?.getReader();if(!reader)return Buffer.alloc(0);
  const chunks:Buffer[]=[];let bytes=0;
  try { for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>limit){await reader.cancel();throw new RequestRejected(413,"请求内容过大");}chunks.push(Buffer.from(next.value));} }
  finally {reader.releaseLock();}return Buffer.concat(chunks,bytes);
}
export async function readLimitedJson(request:Request,limit=16384):Promise<Record<string,unknown>> {
  const body=JSON.parse((await readLimitedBody(request,limit)).toString());
  if(!body||typeof body!=="object"||Array.isArray(body))throw new RequestRejected(400,"请求格式不对");return body;
}
export function errorResponse(error:unknown):Response {
  return Response.json({error:error instanceof RequestRejected?error.message:"请求无法处理"},{status:error instanceof RequestRejected?error.status:400});
}

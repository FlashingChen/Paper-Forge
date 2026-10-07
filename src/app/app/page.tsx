"use client";

import { BETA_CONTACT } from "@/lib/beta-contact";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import UserBar from "@/components/UserBar";
import UploadZone from "@/components/UploadZone";
import { LevelBar, type HudUser } from "@/components/Hud";
import { downscaleImage, ImageError } from "@/lib/image";

const MAX_IMAGES = 20;

const SHOOTING_TIPS = [
  "尽量正着拍",
  "只拍要用的那一页",
  "光线均匀别有阴影",
  "一页一张图",
];

interface Item {
  key: string;
  originalName: string;
  previewUrl: string;
  blob: Blob;
  filename: string;
  width: number;
  height: number;
}

let keySeed = 0;
function nextKey(): string {
  keySeed += 1;
  return `img-${Date.now().toString(36)}-${keySeed}`;
}

export default function HomePage() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progressText, setProgressText] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const atLimit = items.length >= MAX_IMAGES;
  const remaining = Math.max(0, MAX_IMAGES - items.length);
  /**
   * Generations left for this account. UserBar owns the single /api/auth/me
   * fetch and hands the result up, so the HUD chip, the sidebar strip and the
   * submit-button guard can never disagree about the balance.
   */
  const [account, setAccount] = useState<HudUser | null>(null);
  const quotaLeft = account ? account.remaining : null;
  const [quotaBump, setQuotaBump] = useState(0);

  const onUser = useCallback((user: HudUser | null) => {
    setAccount(user);
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      setWarning(null);
      setError(null);

      const room = MAX_IMAGES - items.length;
      if (room <= 0) {
        setWarning(`最多只能上传 ${MAX_IMAGES} 张照片。`);
        return;
      }
      const accepted = files.slice(0, room);
      if (accepted.length < files.length) {
        setWarning(`最多只能上传 ${MAX_IMAGES} 张照片，多出的已忽略。`);
      }

      const added: Item[] = [];
      const failed: string[] = [];

      for (const file of accepted) {
        setProgressText(`正在准备照片 ${file.name} …`);
        try {
          const result = await downscaleImage(file, 2000);
          added.push({
            key: nextKey(),
            originalName: file.name,
            previewUrl: URL.createObjectURL(result.blob),
            blob: result.blob,
            filename: result.filename,
            width: result.width,
            height: result.height,
          });
        } catch (err) {
          const message =
            err instanceof ImageError
              ? err.message
              : `处理 ${file.name} 时出错，已跳过。`;
          failed.push(message);
        }
      }

      setProgressText(null);

      if (added.length > 0) {
        setItems((prev) => [...prev, ...added].slice(0, MAX_IMAGES));
      }
      if (failed.length > 0) {
        setError(failed.join(" "));
      }
    },
    [items.length],
  );

  const move = useCallback((index: number, delta: number) => {
    setItems((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  const remove = useCallback((index: number) => {
    setItems((prev) => {
      const victim = prev[index];
      if (!victim) return prev;
      URL.revokeObjectURL(victim.previewUrl);
      const next = prev.slice();
      next.splice(index, 1);
      return next;
    });
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    if (submittingRef.current || busy) return;
    if (items.length === 0) {
      setError("请先添加至少一张试卷照片。");
      return;
    }

    submittingRef.current = true;
    setBusy(true);
    setError(null);
    setProgressText("正在上传 …");

    try {
      const form = new FormData();
      for (const item of items) {
        form.append("images", item.blob, item.filename);
      }

      const response = await fetch("/api/jobs", {
        method: "POST",
        body: form,
      });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message =
          payload &&
          typeof payload === "object" &&
          typeof (payload as { error?: unknown }).error === "string"
            ? String((payload as { error: string }).error)
            : `上传失败（HTTP ${response.status}）。`;
        throw new Error(message);
      }

      const id =
        payload &&
        typeof payload === "object" &&
        typeof (payload as { id?: unknown }).id === "string"
          ? String((payload as { id: string }).id)
          : "";

      if (!id) {
        throw new Error("服务器没有返回任务编号，请重试。");
      }

      setQuotaBump((n) => n + 1);

      setProgressText("上传完成，正在跳转 …");
      router.push(`/job/${encodeURIComponent(id)}`);
    } catch (err) {
      submittingRef.current = false;
      setBusy(false);
      setProgressText(null);
      const message =
        err instanceof Error && err.message
          ? err.message
          : "上传失败，请检查网络后重试。";
      setError(message);
    }
  }, [busy, items, router]);

  return (
    <div>
      <UserBar refreshKey={quotaBump} level={1} onUser={onUser} />
      <LevelBar current={1} />

      <main className="stage">
        <section className="panel" aria-labelledby="upload-heading">
          <div className="panel-h">
            <h2 id="upload-heading">
              <span className="px" style={{ color: "var(--l2-c)" }} aria-hidden="true">▲</span>
              先选好练习卷照片
            </h2>
            <span className="aside">
              {items.length > 0
                ? `已选 ${items.length} 张，最多 ${MAX_IMAGES} 张`
                : `${MAX_IMAGES} 张上限`}
            </span>
          </div>

          <div className="panel-b">
            <p className="upload-intro">一页拍一张，多页可以一起选。确认照片清楚、页序正确，再生成 Word。</p>
            <UploadZone
              onFiles={(files) => {
                void addFiles(files);
              }}
              disabled={atLimit || busy || progressText !== null}
              disabledLabel={atLimit ? "已选满 20 张照片" : "正在准备照片，请稍等"}
              hint={
                atLimit
                  ? `已经到 ${MAX_IMAGES} 张上限了，删掉一张再加。`
                  : `也可以把照片直接拖进来 · 支持 JPG / PNG · 还剩 ${remaining} 张可以加`
              }
            />

            {/* 页序是这屏的隐形核心：拍反了输出就错，所以序号要最大。 */}
            {items.length > 0 ? (
              <div className="pages">
                {items.map((item, index) => (
                  <div className="page-row" key={item.key}>
                    <span className="page-ord" aria-hidden="true">
                      {index + 1}
                    </span>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className="page-thumb"
                      src={item.previewUrl}
                      alt={`第 ${index + 1} 张的缩略图`}
                    />
                    <div className="page-info">
                      <b>第 {index + 1} 页</b>
                      <span className="nm" title={item.originalName}>
                        {item.originalName}
                      </span>
                    </div>
                    <div className="page-acts">
                      <button
                        type="button"
                        className="sq"
                        onClick={() => move(index, -1)}
                        disabled={index === 0 || busy}
                        aria-label={`把第 ${index + 1} 张往前移`}
                        title="往前移"
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        className="sq"
                        onClick={() => move(index, 1)}
                        disabled={index === items.length - 1 || busy}
                        aria-label={`把第 ${index + 1} 张往后移`}
                        title="往后移"
                      >
                        →
                      </button>
                      <button
                        type="button"
                        className="sq del"
                        onClick={() => remove(index)}
                        disabled={busy}
                        aria-label={`删除第 ${index + 1} 张`}
                        title="删除"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {warning ? (
              <div className="alert alert-warn" role="status">
                {warning}
              </div>
            ) : null}

            {error ? (
              <div className="alert alert-error" role="alert">
                {error}
              </div>
            ) : null}

            <button
              type="button"
              className="act go"
              onClick={() => {
                void submit();
              }}
              disabled={busy || progressText !== null || items.length === 0 || quotaLeft === 0}
            >
              {busy ? (
                <>
                  <span className="blink" aria-hidden="true">▮</span>
                  {progressText ?? "正在处理 …"}
                </>
              ) : quotaLeft === 0 ? (
                "生成次数已用完"
              ) : (
                <>
                  <span className="px" aria-hidden="true">▶</span>
                  把照片整理成 Word
                  <span className="px" aria-hidden="true">▶</span>
                </>
              )}
            </button>

            {quotaLeft === 0 ? (
              <p className="alert alert-warn" role="alert">
                本次试用次数已用完，可以私信{BETA_CONTACT}咨询。
              </p>
            ) : (
              <p className="hintline" style={{ textAlign: "center" }}>
                每次生成使用 1 次额度，多张照片会合成一份 Word。生成后请核对题目。
              </p>
            )}

            {/* 版权/合规提示：放在提交按钮下方，也就是责任实际发生的位置。
                法律语义必须一字不改，不要为了排版去改写措辞。 */}
            <p className="legal">
              请确保您上传和处理的内容拥有合法使用权，或属于教学、研究等法律允许的合理使用范围。
            </p>
          </div>
        </section>

        {/* 侧栏 HUD：额度 + 拍照提示 + 「你会得到什么」 */}
        <aside className="side">
          <div className="hudbox">
            <div className="strip">
              <span>还可以生成</span>
              <b>{quotaLeft === null ? "…" : `${quotaLeft} 次`}</b>
            </div>
            <div className="b">
              <h3>拍照小提示</h3>
              {SHOOTING_TIPS.map((tip) => (
                <div className="tip" key={tip}>
                  {tip}
                </div>
              ))}
            </div>
          </div>

          <div className="hudbox">
            <div className="strip green">
              <span>你会得到</span>
              <b>1 份 Word</b>
            </div>
            <div className="b">
              <div className="alchemy" aria-hidden="true">
                <span className="alch-in">
                  {items.slice(0, 2).map((item) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={item.key} src={item.previewUrl} alt="" />
                  ))}
                  {items.length === 0 ? <span className="blank" /> : null}
                  {items.length === 1 ? <span className="blank" /> : null}
                </span>
                <span className="alch-arrow" />
                <span className="alch-out">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </div>
              <p className="alch-cap">
                用 Word 或 WPS 打开，<b>改题目、调版面，再打印</b>。
              </p>
            </div>
          </div>

          <div className="hudbox">
            <div className="b">
              <h3>接下来会发生什么</h3>
              <div className="tip">识别照片里的题目</div>
              <div className="tip">整理版面，留出答题空间</div>
              <div className="tip">生成 Word，可以直接下载</div>
              <p className="hintline">
                生成需要一些时间。上传后先保存结果链接，稍后可以回来下载。
              </p>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

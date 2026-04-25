const CURL =
  process.platform === "darwin"
    ? "/opt/homebrew/opt/curl/bin/curl"
    : process.platform === "win32"
      ? "C:\\Windows\\System32\\curl.exe"
      : "/usr/bin/curl";

async function curlFetch(
  url: string | URL,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const args = ["-s", "-L"];
  for (const [key, value] of Object.entries(headers ?? {})) {
    args.push("-H", `${key}: ${value}`);
  }
  args.push(url.toString());

  const proc = Bun.spawn([CURL, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (signal) {
    signal.addEventListener("abort", () => proc.kill());
  }

  const [body, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`curl exited ${exitCode}: ${stderr}`);
  }
  return new Response(body, { status: 200 });
}

export async function fetchWithRetry<T = Response>(
  url: string | URL,
  params?: {
    options?: BunFetchRequestInit;
    resolveWhen?: (res: Response) => Promise<T>;
    totalRetry?: number;
    retryBackOff?: (currentRetry: number) => number;
    _currentRetry?: number;
    useCurl?: boolean;
    abort?: AbortSignal;
    /** Called on every fetch error before retrying. Throw or call process.exit() to abort. */
    onError?: (err: unknown) => void;
  },
): Promise<T> {
  function sleep(millis: number) {
    return new Promise((r) => setTimeout(r, millis));
  }

  const _params = params ?? {};
  const retryTimes = _params.totalRetry ?? 3;
  const currentRetry = _params._currentRetry ?? 0;

  if (_params.abort?.aborted) return undefined as T;

  try {
    const res = _params.useCurl
      ? await curlFetch(
          url,
          _params.options?.headers as Record<string, string>,
          _params.abort,
        )
      : await fetch(url, _params.options);
    if (!res.ok) {
      const obj = await res.text();
      throw Error(obj);
    }
    if (params?.resolveWhen) {
      return await params.resolveWhen(res);
    } else {
      return res as T;
    }
  } catch (e) {
    // do not retry on abort
    if (e instanceof DOMException && e.name === "AbortError")
      return undefined as T;

    // caller-supplied error hook (may call process.exit or throw to stop retrying)
    if (params?.onError) params.onError(e);

    // retry
    if (retryTimes - currentRetry <= 0) throw e;
    let delay: number;
    if (params?.retryBackOff) {
      delay = params.retryBackOff(currentRetry);
    } else {
      delay = 1000 * Math.pow(2, currentRetry);
    }
    if (_params.abort?.aborted) return undefined as T;
    await sleep(delay);
    return await fetchWithRetry(url, {
      ..._params,
      _currentRetry: currentRetry + 1,
    });
  }
}

import net from "node:net";
import { socketPath } from "./protocol.js";

/** Sends one control message to the running daemon and returns its first reply line. */
export const request = (message: string, timeoutMs = 2000): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let reply = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("daemon did not answer"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(message + "\n"));
    socket.on("data", (chunk: string) => {
      reply += chunk;
      const newline = reply.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(timer);
        socket.destroy();
        resolve(reply.slice(0, newline));
      }
    });
    // `on`, not `once`: a daemon going away can raise a second error (EPIPE after ECONNRESET)
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`daemon not running (${(e as NodeJS.ErrnoException).code ?? e.message})`));
    });
  });

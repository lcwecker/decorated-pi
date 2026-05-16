import { setupArkCoding } from "./ark-coding.js";
import { setupOllamaCloud } from "./ollama-cloud.js";
import { setupQianfanCoding } from "./qianfan-coding.js";

export function setupProviders(pi: any) {
  setupArkCoding(pi);
  setupOllamaCloud(pi);
  setupQianfanCoding(pi);
}
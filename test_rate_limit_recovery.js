const axios = require('axios');

// 目标API，使用一个常见的收藏夹ID
const TARGET_URL = 'https://api.bilibili.com/x/v3/fav/resource/list?media_id=1131277602&pn=1&ps=20';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15',
  'Referer': 'https://www.bilibili.com/'
};

// 探测间隔：如果探测过于频繁（如200ms），可能会导致服务端的限流窗口不断被重置，从而永远无法恢复。
// 这里改为 3000ms (3秒)，既能相对准确地捕获恢复时间，又不会对服务器造成持续高压。
const PROBE_INTERVAL_MS = 30000; 
const CONCURRENCY = 30; // 并发 Worker 数量，增加并发以确保触发真正的限流
const MAX_PROBE_DURATION_MS = 5 * 60 * 1000; // 最大探测时长：5分钟，防止脚本无限挂起

let rateLimitTriggered = false;
let triggerTime = 0;
let triggerDetails = null;

/**
 * 发送单个请求并严格解析结果
 */
async function makeRequest() {
  try {
    const response = await axios.get(TARGET_URL, { headers: HEADERS, timeout: 5000 });
    const data = response.data;
    
    // 严格判断限流：响应体 code 为 -412
    if (data && data.code === -412) {
      return { type: 'rate_limit', status: response.status, data };
    }
    // 严格判断成功：code 为 0
    if (data && data.code === 0) {
      return { type: 'success', status: response.status, data };
    }
    // 其他业务错误
    return { type: 'other_error', status: response.status, data };
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      // 严格判断限流：HTTP 状态码 412 或 429，或者响应体 code 为 -412
      if (status === 412 || status === 429 || (data && data.code === -412)) {
        return { type: 'rate_limit', status, data, message: error.message };
      }
      return { type: 'other_error', status, data, message: error.message };
    }
    // 网络错误（如超时、连接重置等）
    return { type: 'network_error', message: error.message };
  }
}

/**
 * 持续发送请求的 Worker
 */
async function worker(id) {
  while (!rateLimitTriggered) {
    const result = await makeRequest();
    
    if (result.type === 'rate_limit' && !rateLimitTriggered) {
      rateLimitTriggered = true;
      triggerTime = Date.now();
      triggerDetails = result;
      console.log(`\n\n[Worker ${id}] 成功触发限流!`);
      console.log(`触发时间戳: ${triggerTime} (${new Date(triggerTime).toISOString()})`);
      console.log(`HTTP 状态码: ${result.status}`);
      console.log(`响应体: ${JSON.stringify(result.data)}`);
      if (result.message) {
        console.log(`错误信息: ${result.message}`);
      }
    } else if (!rateLimitTriggered) {
      // 仅在未触发限流时打印进度
      if (result.type === 'success') {
        process.stdout.write('.');
      } else {
        process.stdout.write('e'); // 打印 e 表示遇到了非限流的其他错误
      }
    }
  }
}

/**
 * 高频请求触发限流
 */
async function triggerRateLimit() {
  console.log('=========================================');
  console.log('阶段 1: 开始持续高频请求以触发限流...');
  console.log(`目标 URL: ${TARGET_URL}`);
  console.log(`并发 Worker 数量: ${CONCURRENCY}`);
  console.log('=========================================');
  
  // 启动所有 Worker
  Array.from({ length: CONCURRENCY }).forEach((_, i) => worker(i));
  
  // 等待直到触发限流
  while (!rateLimitTriggered) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  // 稍微等待一下，让其他正在进行中的请求完成，避免日志混乱
  await new Promise(resolve => setTimeout(resolve, 500));
  
  return triggerTime;
}

/**
 * 探测限流恢复时间
 */
async function probeRecovery(startTime) {
  console.log('\n=========================================');
  console.log(`阶段 2: 开始探测恢复时间...`);
  console.log(`探测间隔: ${PROBE_INTERVAL_MS}ms`);
  console.log(`最大超时: ${MAX_PROBE_DURATION_MS / 1000}秒`);
  console.log('图例: [x]限流中 [?]其他错误 [!]网络错误');
  console.log('=========================================');
  
  let probeCount = 0;
  let lastReportTime = Date.now();
  
  while (true) {
    probeCount++;
    const probeStartTime = Date.now();
    const elapsedSinceTrigger = probeStartTime - startTime;
    
    // 检查是否超时
    if (elapsedSinceTrigger > MAX_PROBE_DURATION_MS) {
      console.log(`\n\n[超时退出] 探测时间已超过最大限制 (${MAX_PROBE_DURATION_MS / 1000}秒)，限流仍未解除。`);
      console.log(`这可能意味着您的 IP 被封禁了较长时间，或者探测请求本身导致了限流时间的延长。`);
      return -1;
    }

    // 每隔约 10 秒汇报一次当前耗时
    if (probeStartTime - lastReportTime >= 10000) {
      console.log(`\n[状态汇报] 已持续限流 ${(elapsedSinceTrigger / 1000).toFixed(1)} 秒...`);
      lastReportTime = probeStartTime;
    }

    const result = await makeRequest();
    
    if (result.type === 'success') {
      const endTime = Date.now();
      const duration = endTime - startTime;
      console.log(`\n\n=========================================`);
      console.log(`[限流已完全解除]`);
      console.log(`恢复时间戳: ${endTime} (${new Date(endTime).toISOString()})`);
      console.log(`探测请求次数: ${probeCount}`);
      console.log(`-----------------------------------------`);
      console.log(`限流持续总时长: ${duration} 毫秒`);
      console.log(`折合秒数: ${(duration / 1000).toFixed(3)} 秒`);
      console.log(`=========================================`);
      return duration;
    } else if (result.type === 'rate_limit') {
      process.stdout.write('x');
    } else if (result.type === 'other_error') {
      process.stdout.write('?'); 
    } else {
      process.stdout.write('!');
    }
    
    // 保证固定的探测间隔
    const elapsed = Date.now() - probeStartTime;
    const waitTime = Math.max(0, PROBE_INTERVAL_MS - elapsed);
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

/**
 * 主函数
 */
async function main() {
  try {
    // 前置探测请求：检查当前 API 是否已处于限流中
    const preCheckResult = await makeRequest();
    if (preCheckResult.type === 'rate_limit') {
      console.warn('\n[警告] 当前 API 已处于限流状态，测试已中止。');
      process.exit(1);
    }
    const startTime = await triggerRateLimit();
    await probeRecovery(startTime);
    process.exit(0);
  } catch (error) {
    console.error('\n测试过程中发生未捕获异常:', error);
    process.exit(1);
  }
}

main();

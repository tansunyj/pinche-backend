const { query } = require('../db/init');

// ==================== 计费配置缓存 ====================
let TIERED_PRICES = {};
let FLAT_PRICES = {};
let IMAGE_PRICES = {};
let VIDEO_PRICES = {};
let VIDEO_TOKEN_PRICES = {}; // 视频按token计费（Seedance）

/**
 * 从数据库加载定价配置到内存缓存
 */
async function loadPricesFromDb() {
  try {
    const rows = await query('SELECT * FROM proxy_model_prices');

    // 重置配置
    const newTiered = {};
    const newFlat = {};
    const newImage = {};
    const newVideo = {};
    const newVideoToken = {}; // 视频按token计费

    rows.forEach(row => {
      const model = row.model;
      const config = row.config_json || {};

      if (row.type === 'tiered') {
        if (!newTiered[model]) newTiered[model] = { tiers: [] };
        newTiered[model].tiers.push({
          maxInputTokens: row.max_input_tokens || Infinity,
          input: parseFloat(row.input_price_per_m),
          output: parseFloat(row.output_price_per_m),
          thinkingOutput: parseFloat(row.thinking_output_per_m)
        });
      } else if (row.type === 'flat') {
        newFlat[model] = {
          input: parseFloat(row.input_price_per_m),
          output: parseFloat(row.output_price_per_m),
          thinkingOutput: parseFloat(row.thinking_output_per_m)
        };
      } else if (row.type === 'image') {
        newImage[model] = { pricePerImage: parseFloat(row.price_per_image) };
      } else if (row.type === 'video') {
        newVideo[model] = {
          pricePerSecond: parseFloat(row.price_per_second_720),
          pricePerSecond1080: parseFloat(row.price_per_second_1080)
        };
      } else if (row.type === 'video_token') {
        // 视频按token计费（Seedance）
        // 官方价格：480p和720p同价(46/28)，1080p(51/31)，4k(26/16)
        newVideoToken[model] = {
          // 按分辨率和是否含视频输入的价格（元/百万 tokens）
          '480p_noInput': parseFloat(config['480p_noInput'] || 46.00),
          '480p_withInput': parseFloat(config['480p_withInput'] || 28.00),
          '720p_noInput': parseFloat(config['720p_noInput'] || 46.00),
          '720p_withInput': parseFloat(config['720p_withInput'] || 28.00),
          '1080p_noInput': parseFloat(config['1080p_noInput'] || 51.00),
          '1080p_withInput': parseFloat(config['1080p_withInput'] || 31.00),
          '4k_noInput': parseFloat(config['4k_noInput'] || 26.00),
          '4k_withInput': parseFloat(config['4k_withInput'] || 16.00),
        };
      }
    });

    // 排序阶梯
    Object.values(newTiered).forEach(data => {
      data.tiers.sort((a, b) => a.maxInputTokens - b.maxInputTokens);
    });

    // 原子更新
    TIERED_PRICES = newTiered;
    FLAT_PRICES = newFlat;
    IMAGE_PRICES = newImage;
    VIDEO_PRICES = newVideo;
    VIDEO_TOKEN_PRICES = newVideoToken;

    console.log(`[Billing] 成功从数据库加载 ${rows.length} 条计费规则`);
    console.log(`[Billing] 视频按token计费模型: ${Object.keys(newVideoToken).join(', ') || '无'}`);
  } catch (err) {
    console.error('[Billing Error] 无法从数据库加载价格:', err);
  }
}

// 初始化加载
loadPricesFromDb();

// 默认单价
const DEFAULT_PRICE = { input: 2.0, output: 8.0, thinkingOutput: 8.0 };

// 额度换算系数（1元 = 100000 额度）
const QUOTA_PER_YUAN = 100000;

/**
 * 查找模型的阶梯价格
 */
function findTierPrice(model, promptTokens, isThinking) {
  const tiered = TIERED_PRICES[model];
  if (tiered) {
    for (const tier of tiered.tiers) {
      if (promptTokens <= tier.maxInputTokens) {
        return {
          input: tier.input,
          output: isThinking ? (tier.thinkingOutput || tier.output) : tier.output,
          isThinking,
          tierInfo: tier.maxInputTokens === Infinity
            ? '固定单价'
            : `输入≤${tier.maxInputTokens >= 1000000 ? (tier.maxInputTokens / 1000000) + 'M' : (tier.maxInputTokens / 1000) + 'K'} Token`,
        };
      }
    }
    const last = tiered.tiers[tiered.tiers.length - 1];
    return {
      input: last.input,
      output: isThinking ? (last.thinkingOutput || last.output) : last.output,
      isThinking,
      tierInfo: '最高阶梯',
    };
  }
  const flat = FLAT_PRICES[model];
  if (flat) {
    return {
      input: flat.input,
      output: isThinking ? (flat.thinkingOutput || flat.output) : flat.output,
      isThinking,
      tierInfo: '固定单价',
    };
  }
  return {
    input: DEFAULT_PRICE.input,
    output: isThinking ? DEFAULT_PRICE.thinkingOutput : DEFAULT_PRICE.output,
    isThinking,
    tierInfo: '默认单价',
  };
}

/**
 * 判断是否为思考模式请求
 */
function isThinkingRequest(body) {
  if (!body) return false;
  if (body.enable_thinking === true) return true;
  if (body.thinking === true) return true;
  if (body.thinking_budget && body.thinking_budget > 0) return true;
  if (body.extra_body?.enable_thinking === true) return true;
  if (body.model?.includes('thinking')) return true;
  return false;
}

/**
 * 计算费用详情
 */
function calculateCost(model, promptTokens, completionTokens, isThinking, priceMarkup) {
  const markup = priceMarkup || 1.0;
  const priceLabel = markup < 1
    ? `× 折扣${markup}倍(${Math.round(markup * 100) / 10}折)`
    : markup > 1 ? `× 加价${markup}倍` : '';

  // 图片计费
  const imgPrice = IMAGE_PRICES[model];
  if (imgPrice) {
    const totalCost = imgPrice.pricePerImage * markup;
    return {
      inputCost: 0,
      outputCost: totalCost,
      totalCost: Math.round(totalCost * 10000) / 10000,
      imageOrVideo: true,
      billingNote: `官方价${imgPrice.pricePerImage}元/张 ${priceLabel}`,
      inputPricePerM: 0,
      outputPricePerM: 0,
      isThinking: false,
      tierInfo: '按张计费',
      markup,
    };
  }

  // 视频按秒计费
  const vidPrice = VIDEO_PRICES[model];
  if (vidPrice) {
    const defaultSeconds = 5;
    const baseCost = vidPrice.pricePerSecond * defaultSeconds;
    const totalCost = baseCost * markup;
    return {
      inputCost: 0,
      outputCost: totalCost,
      totalCost: Math.round(totalCost * 10000) / 10000,
      imageOrVideo: true,
      billingNote: `官方价${vidPrice.pricePerSecond}元/秒(720P) × ${defaultSeconds}秒 ${priceLabel}`,
      inputPricePerM: 0,
      outputPricePerM: 0,
      isThinking: false,
      tierInfo: '按秒计费',
      markup,
    };
  }

  // 视频按token计费（Seedance）
  const vidTokenPrice = VIDEO_TOKEN_PRICES[model];
  if (vidTokenPrice) {
    // 默认按720p、不含视频输入计算预估费用
    const pricePer1M = vidTokenPrice['720p_noInput'];
    const estimatedTokens = 1000000; // 预估100万tokens
    const baseCost = (estimatedTokens / 1000000) * pricePer1M;
    const totalCost = baseCost * markup;
    return {
      inputCost: 0,
      outputCost: totalCost,
      totalCost: Math.round(totalCost * 10000) / 10000,
      imageOrVideo: true,
      billingNote: `视频按Token计费 官方价${pricePer1M}元/百万Tokens(720P) ${priceLabel}`,
      inputPricePerM: 0,
      outputPricePerM: pricePer1M,
      isThinking: false,
      tierInfo: '视频按Token计费',
      markup,
      videoTokenPrice: vidTokenPrice, // 返回完整价格表供实际扣费时使用
    };
  }

  // Token 计费
  const price = findTierPrice(model, promptTokens, isThinking);
  const inputCost = (promptTokens / 1000000) * price.input * markup;
  const outputCost = (completionTokens / 1000000) * price.output * markup;
  const totalCost = inputCost + outputCost;

  return {
    inputCost: Math.round(inputCost * 1000000) / 1000000,
    outputCost: Math.round(outputCost * 1000000) / 1000000,
    totalCost: Math.round(totalCost * 10000) / 10000,
    inputPricePerM: price.input,
    outputPricePerM: price.output,
    isThinking: price.isThinking,
    tierInfo: price.tierInfo,
    markup,
    billingNote: `${price.tierInfo} | ${isThinking ? '思考模式' : '非思考模式'} | 输入${price.input}元/M 输出${price.output}元/M${priceLabel ? ' ' + priceLabel : ''}`,
  };
}

/**
 * 计算额度消耗
 */
function calculateQuota(model, promptTokens, completionTokens, isThinking, priceMarkup) {
  const markup = priceMarkup || 1.0;

  // 图片计费
  const imgPrice = IMAGE_PRICES[model];
  if (imgPrice) {
    return Math.max(1, Math.round(imgPrice.pricePerImage * markup * QUOTA_PER_YUAN));
  }

  // 视频按秒计费
  const vidPrice = VIDEO_PRICES[model];
  if (vidPrice) {
    const defaultSeconds = 5;
    const baseCost = vidPrice.pricePerSecond * defaultSeconds;
    const totalCost = baseCost * markup;
    return Math.max(1, Math.round(totalCost * QUOTA_PER_YUAN));
  }

  // 视频按token计费（Seedance）- 预扣用预估，实际按API返回的tokens计算
  const vidTokenPrice = VIDEO_TOKEN_PRICES[model];
  if (vidTokenPrice) {
    // 预扣时按720p、不含视频输入的价格估算
    const pricePer1M = vidTokenPrice['720p_noInput'];
    // 预估100万tokens（实际扣费时按API返回的completion_tokens计算）
    const estimatedTokens = 1000000;
    const totalCost = (estimatedTokens / 1000000) * pricePer1M * markup;
    return Math.max(1, Math.round(totalCost * QUOTA_PER_YUAN));
  }

  // Token 计费 - 使用高精度计算避免浮点误差
  const price = findTierPrice(model, promptTokens, isThinking);
  const inputCostRaw = promptTokens * price.input * markup;
  const outputCostRaw = completionTokens * price.output * markup;
  const totalCost = (inputCostRaw + outputCostRaw) / 1000000;

  return Math.max(1, Math.round(totalCost * QUOTA_PER_YUAN));
}

/**
 * 格式化费用显示
 */
function formatCost(yuan) {
  return '¥' + Number(yuan).toFixed(4);
}

/**
 * 额度转人民币
 */
function quotaToYuan(quota) {
  return (quota / QUOTA_PER_YUAN).toFixed(4);
}

/**
 * 人民币转额度
 */
function yuanToQuota(yuan) {
  return Math.round(yuan * QUOTA_PER_YUAN);
}

/**
 * 获取模型价格列表（从缓存返回，用于兼容旧代码）
 */
function getModelPriceList() {
  const result = [];
  for (const [model, data] of Object.entries(TIERED_PRICES)) {
    data.tiers.forEach(tier => {
      result.push({ model, type: 'tiered', maxInputTokens: tier.maxInputTokens, inputPricePerM: tier.input, outputPricePerM: tier.output, thinkingOutputPerM: tier.thinkingOutput || tier.output, tierLabel: tier.maxInputTokens === Infinity ? '固定单价' : `≤${tier.maxInputTokens >= 1000000 ? (tier.maxInputTokens / 1000000) + 'M' : (tier.maxInputTokens / 1000) + 'K'}` });
    });
  }
  for (const [model, data] of Object.entries(FLAT_PRICES)) {
    result.push({ model, type: 'flat', maxInputTokens: Infinity, inputPricePerM: data.input, outputPricePerM: data.output, thinkingOutputPerM: data.thinkingOutput || data.output, tierLabel: '固定单价' });
  }
  for (const [model, data] of Object.entries(IMAGE_PRICES)) {
    result.push({ model, type: 'image', pricePerImage: data.pricePerImage, tierLabel: '按张计费' });
  }
  for (const [model, data] of Object.entries(VIDEO_PRICES)) {
    result.push({ model, type: 'video', pricePerSecond720: data.pricePerSecond, pricePerSecond1080: data.pricePerSecond1080, tierLabel: '按秒计费' });
  }
  for (const [model, data] of Object.entries(VIDEO_TOKEN_PRICES)) {
    result.push({
      model,
      type: 'video_token',
      pricePerSecond720: data['720p_noInput'],
      pricePerSecond1080: data['1080p_noInput'],
      tierLabel: '视频按Token计费',
      // 返回完整价格配置
      videoTokenPrices: {
        '480p_noInput': data['480p_noInput'],
        '480p_withInput': data['480p_withInput'],
        '720p_noInput': data['720p_noInput'],
        '720p_withInput': data['720p_withInput'],
        '1080p_noInput': data['1080p_noInput'],
        '1080p_withInput': data['1080p_withInput'],
        '4k_noInput': data['4k_noInput'],
        '4k_withInput': data['4k_withInput'],
      }
    });
  }
  return result;
}

/**
 * 获取所有支持的模型列表
 */
function getAllModels() {
  const models = new Set([
    ...Object.keys(TIERED_PRICES),
    ...Object.keys(FLAT_PRICES),
    ...Object.keys(IMAGE_PRICES),
    ...Object.keys(VIDEO_PRICES),
    ...Object.keys(VIDEO_TOKEN_PRICES),
  ]);
  return Array.from(models).sort();
}

/**
 * 计算视频按Token的实际费用（用于Seedance实际扣费）
 *
 * @param model 模型ID
 * @param completionTokens 实际消耗的completion_tokens
 * @param resolution 分辨率 (480p/720p/1080p/4k)
 * @param hasVideoInput 是否有视频输入
 * @param priceMarkup 价格加成
 * @returns {number} 额度消耗
 */
function calculateVideoTokenQuota(model, completionTokens, resolution = '720p', hasVideoInput = false, priceMarkup = 1.0) {
  const vidTokenPrice = VIDEO_TOKEN_PRICES[model];
  if (!vidTokenPrice) {
    console.warn(`[Billing] 未找到视频按Token计费配置: ${model}`);
    return 0;
  }

  const res = resolution.toLowerCase();
  const key = `${res}_${hasVideoInput ? 'withInput' : 'noInput'}`;
  let pricePer1M = vidTokenPrice[key];

  // 如果找不到对应配置，使用720p_noInput作为默认
  if (!pricePer1M) {
    pricePer1M = vidTokenPrice['720p_noInput'];
    console.warn(`[Billing] 未找到${key}价格配置，使用720p_noInput: ${pricePer1M}`);
  }

  const markup = priceMarkup || 1.0;
  const totalCost = (completionTokens / 1000000) * pricePer1M * markup;
  const quota = Math.max(1, Math.round(totalCost * QUOTA_PER_YUAN));

  console.log(`[Billing] 视频按Token计费: model=${model}, tokens=${completionTokens}, resolution=${resolution}, hasVideoInput=${hasVideoInput}, price=${pricePer1M}元/M, quota=${quota}`);

  return quota;
}

/**
 * 渠道类型
 */
const CHANNEL_TYPES = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'claude', label: 'Anthropic Claude' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'kimi', label: 'Kimi/Moonshot' },
  { value: 'ali', label: '阿里云百炼' },
  { value: 'custom', label: '自定义' },
];

module.exports = {
  loadPricesFromDb,
  findTierPrice,
  isThinkingRequest,
  calculateCost,
  calculateQuota,
  calculateVideoTokenQuota, // 视频按Token计费
  formatCost,
  quotaToYuan,
  yuanToQuota,
  getModelPriceList,
  getAllModels,
  CHANNEL_TYPES,
};

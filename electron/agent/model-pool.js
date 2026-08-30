const { completeJson, modelError } = require("./llm");

// 主模型和备用模型。主的连不上就让备用顶上去，别让筛选队列在那儿干等。
//
// 切换是"粘"的：主模型断网的时候，每批都先去撞一次那 60 秒的超时才轮到备用，一批
// 8 条就白等一分钟。所以切过去之后就先一直用备用，等冷却时间到了再回头试主模型一次。
const RECHECK_AFTER_MS = 5 * 60 * 1000;

// 这几类换一家可能就好了：这家挂了、在限流、Key 不对、模型名不对。
// response 不算——连上了也答了，只是答的不是能用的 JSON，那多半是这批内容让模型
// 犯了迷糊，换一家大概率一样，白花一遍 token。
const WORTH_SWITCHING = new Set(["network", "rate", "auth", "model"]);

function usable(...fields) {
  return fields.every((field) => String(field || "").trim());
}

class ModelPool {
  /** notify(message) 用来把切换这件事说给界面听，不影响调用结果。 */
  constructor(settings, notify = () => {}) {
    this.notify = notify;
    this.candidates = [];
    // 地址、模型、Key 三样齐了才算一个能用的候选。缺一样就把它算进来，只会让每批
    // 内容先去撞一个"请先填写地址"的错，还占着首选的位置把真配好的那家挡在后面。
    if (usable(settings?.baseUrl, settings?.model, settings?.apiKey)) {
      this.candidates.push({
        role: "主模型",
        settings: {
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          apiFormat: settings.apiFormat,
        },
      });
    }
    if (usable(settings?.fallbackBaseUrl, settings?.fallbackModel, settings?.fallbackApiKey)) {
      this.candidates.push({
        role: "备用模型",
        settings: {
          baseUrl: settings.fallbackBaseUrl,
          model: settings.fallbackModel,
          apiKey: settings.fallbackApiKey,
          apiFormat: settings.fallbackApiFormat,
        },
      });
    }
    this.index = 0;
    this.demotedAt = 0;
  }

  hasKey() {
    return this.candidates.length > 0;
  }

  /** 缓存按模型名分区，读缓存时得先知道这批大概会用谁。 */
  preferredModel() {
    return this.candidates[this.index]?.settings.model || "";
  }

  preferredRole() {
    return this.candidates[this.index]?.role || "";
  }

  /** 只有一家可用时，"切换"无从谈起，界面上也不用提这回事。 */
  get switchable() {
    return this.candidates.length > 1;
  }

  // 冷却够了就把首选放回主模型：它多半已经好了，而且主模型那边攒着的判定缓存能接着用。
  maybeRestore() {
    if (this.index === 0 || Date.now() - this.demotedAt < RECHECK_AFTER_MS) {
      return;
    }
    const back = this.candidates[0];
    this.index = 0;
    this.notify(`回头试试${back.role} ${back.settings.model}`);
  }

  async complete({ messages, signal }) {
    if (!this.hasKey()) {
      throw modelError("auth", "请先在设置里填好接口地址、模型名和 API Key");
    }
    this.maybeRestore();

    // 当前首选打头，其余的按原顺序垫在后面
    const order = [this.index, ...this.candidates.keys()].filter(
      (position, at, all) => all.indexOf(position) === at,
    );

    let last = null;
    for (const position of order) {
      const candidate = this.candidates[position];
      try {
        const result = await completeJson({ settings: candidate.settings, messages, signal });
        if (position !== this.index) {
          this.settle(position);
        }
        return { ...result, model: candidate.settings.model, role: candidate.role };
      } catch (error) {
        if (error.name === "AbortError") {
          throw error;
        }
        last = error;
        // 换一家也是同样的结果，就别浪费那次请求了
        if (!WORTH_SWITCHING.has(error.kind)) {
          throw error;
        }
        if (position === this.index && this.switchable) {
          this.notify(`${candidate.role} ${candidate.settings.model} 不通：${error.message}`);
        }
      }
    }
    throw last;
  }

  // 顶上来的那家成了，就先认它，并记下时刻，冷却之后再回头试主模型。
  settle(position) {
    const winner = this.candidates[position];
    this.index = position;
    this.demotedAt = Date.now();
    this.notify(`改用${winner.role} ${winner.settings.model}`);
  }
}

module.exports = {
  ModelPool,
  RECHECK_AFTER_MS,
};

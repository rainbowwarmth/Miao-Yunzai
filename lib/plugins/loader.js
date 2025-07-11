import util from "node:util"
import fs from "node:fs/promises"
import lodash from "lodash"
import cfg from "../config/config.js"
import plugin from "./plugin.js"
import schedule from "node-schedule"
import { segment } from "icqq"
import chokidar from "chokidar"
import moment from "moment"
import path from "node:path"
import Runtime from "./runtime.js"
import Handler from "./handler.js"

segment.button = () => ""

/** 全局变量 plugin */
global.plugin = plugin
global.segment = segment

/**
 * 加载插件
 */
class PluginsLoader {
  constructor() {
    this.priority = []
    this.handler = {}
    this.task = []
    this.dir = "plugins"

    /** 命令冷却cd */
    this.groupGlobalCD = {}
    this.singleCD = {}

    /** 插件监听 */
    this.watcher = {}
    this.eventMap = {
      message: ["post_type", "message_type", "sub_type"],
      notice: ["post_type", "notice_type", "sub_type"],
      request: ["post_type", "request_type", "sub_type"],
    }

    this.msgThrottle = {}

    /** 星铁命令前缀 */
    this.srReg = /^#?(\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/
    /** 绝区零前缀 */
    this.zzzReg = /^#?(%|％|绝区零|绝区)+/
  }

  async getPlugins() {
    const files = await fs.readdir(this.dir, { withFileTypes: true })
    const ret = []
    for (const val of files) {
      if (val.isFile()) continue
      const tmp = {
        name: val.name,
        path: `../../${this.dir}/${val.name}`,
      }

      try {
        if (await fs.stat(`${this.dir}/${val.name}/index.js`)) {
          tmp.path = `${tmp.path}/index.js`
          ret.push(tmp)
          continue
        }
      } catch (err) {}

      const apps = await fs.readdir(`${this.dir}/${val.name}`, { withFileTypes: true })
      for (const app of apps) {
        if (!app.isFile()) continue
        if (!app.name.endsWith(".js")) continue
        ret.push({
          name: `${tmp.name}/${app.name}`,
          path: `${tmp.path}/${app.name}`,
        })
        /** 监听热更新 */
        this.watch(val.name, app.name)
      }
    }
    return ret
  }

  /**
   * 监听事件加载
   * @param isRefresh 是否刷新
   */
  async load(isRefresh = false) {
    this.delCount()
    if (isRefresh) this.priority = []
    if (this.priority.length) return

    const files = await this.getPlugins()

    logger.info("-----------")
    logger.info("加载插件中...")

    this.pluginCount = 0
    const packageErr = []

    if (cfg.bot.serial_load) {
      for (const file of files) {
        await this.importPlugin(file, packageErr)
      }
    } else {
      await Promise.allSettled(files.map(file => this.importPlugin(file, packageErr)))
    }

    this.packageTips(packageErr)
    this.createTask()

    logger.info(`加载定时任务[${this.task.length}个]`)
    logger.info(`加载插件[${this.pluginCount}个]`)

    /** 优先级排序 */
    this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])
  }

  async importPlugin(file, packageErr) {
    try {
      let app = await import(file.path)
      if (app.apps) app = { ...app.apps }
      const pluginArray = []
      lodash.forEach(app, p => pluginArray.push(this.loadPlugin(file, p)))
      for (const i of await Promise.allSettled(pluginArray))
        if (i?.status && i.status != "fulfilled") {
          logger.error(`加载插件错误：${logger.red(file.name)}`)
          logger.error(decodeURI(i.reason))
        }
    } catch (error) {
      if (packageErr && error.stack.includes("Cannot find package")) {
        packageErr.push({ error, file })
      } else {
        logger.error(`加载插件错误：${logger.red(file.name)}`)
        logger.error(decodeURI(error.stack))
      }
    }
  }

  async loadPlugin(file, p) {
    if (!p?.prototype) return
    this.pluginCount++
    const plugin = new p()
    logger.debug(`加载插件 [${file.name}][${plugin.name}]`)
    /** 执行初始化，返回 return 则跳过加载 */
    if (plugin.init && (await plugin.init()) == "return") return
    /** 初始化定时任务 */
    this.collectTask(plugin.task)
    this.priority.push({
      class: p,
      key: file.name,
      name: plugin.name,
      priority: plugin.priority,
    })
    if (plugin.handler) {
      lodash.forEach(plugin.handler, ({ fn, key, priority }) => {
        Handler.add({
          ns: plugin.namespace || file.name,
          key,
          self: plugin,
          priority: priority ?? plugin.priority,
          fn: plugin[fn],
        })
      })
    }
  }

  packageTips(packageErr) {
    if (!packageErr || packageErr.length <= 0) return
    logger.mark("--------插件载入错误--------")
    packageErr.forEach(v => {
      let pack = v.error.stack.match(/'(.+?)'/g)[0].replace(/'/g, "")
      logger.mark(`${v.file.name} 缺少依赖：${logger.red(pack)}`)
      logger.mark(`新增插件后请执行安装命令：${logger.red("pnpm i")} 安装依赖`)
      logger.mark(
        `如安装后仍未解决可联系插件作者将 ${logger.red(pack)} 依赖添加至插件的package.json dependencies中，或手工安装依赖`,
      )
    })
    // logger.error('或者使用其他包管理工具安装依赖')
    logger.mark("---------------------")
  }

  /**
   * 处理事件
   *
   * 参数文档 https://oicqjs.github.io/oicq/interfaces/GroupMessageEvent.html
   * @param e icqq Events
   */
  async deal(e) {
    Object.defineProperty(e, "bot", {
      value: Bot[e?.self_id || Bot.uin],
    })
    /** 检查频道消息 */
    if (this.checkGuildMsg(e)) return

    /** 冷却 */
    if (!this.checkLimit(e)) return
    /** 处理消息 */
    this.dealMsg(e)
    /** 检查黑白名单 */
    if (!this.checkBlack(e)) return
    /** 处理回复 */
    this.reply(e)
    /** 注册runtime */
    await Runtime.init(e)

    const priority = []
    for (const i of this.priority) {
      const p = new i.class(e)
      p.e = e
      /** 判断是否启用功能，过滤事件 */
      if (this.checkDisable(p) && this.filtEvent(e, p)) priority.push(p)
    }

    for (const plugin of priority) {
      /** 上下文hook */
      if (!plugin.getContext) continue
      const context = {
        ...plugin.getContext(),
        ...plugin.getContext(false, true),
      }
      if (!lodash.isEmpty(context)) {
        let ret
        for (const fnc in context) {
          ret ||= await plugin[fnc](context[fnc])
        }
        // 返回continue时，继续响应后续插件
        if (ret === "continue") continue
        return
      }
    }

    /** 是否只关注主动at */
    if (!this.onlyReplyAt(e)) return

    // 判断是否是星铁命令，若是星铁命令则标准化处理
    // e.isSr = true，且命令标准化为 #星铁 开头
    Object.defineProperty(e, "isSr", {
      get: () => e.game === "sr",
      set: v => (e.game = v ? "sr" : "gs"),
    })
    Object.defineProperty(e, "isGs", {
      get: () => e.game === "gs",
      set: v => (e.game = v ? "gs" : "sr"),
    })
    if (this.srReg.test(e.msg)) {
      e.game = "sr"
      e.msg = e.msg.replace(this.srReg, "#星铁")
    } else if (this.zzzReg.test(e.msg)) {
      e.game = "zzz"
      // 只替换开头部分
      e.msg = e.msg.replace(this.zzzReg, "#绝区零")
    }

    /** 优先执行 accept */
    for (const plugin of priority)
      if (plugin.accept) {
        const res = await plugin.accept(e)
        if (res == "return") return
        if (res) break
      }

    a: for (const plugin of priority) {
      /** 正则匹配 */
      if (plugin.rule)
        for (const v of plugin.rule) {
          /** 判断事件 */
          if (v.event && !this.filtEvent(e, v)) continue
          if (!new RegExp(v.reg).test(e.msg)) continue
          e.logFnc = `[${plugin.name}][${v.fnc}]`

          if (v.log !== false)
            logger.info(`${e.logFnc}${e.logText} ${lodash.truncate(e.msg, { length: 100 })}`)

          /** 判断权限 */
          if (!this.filtPermission(e, v)) break a

          try {
            const start = Date.now()
            const res = plugin[v.fnc] && (await plugin[v.fnc](e))
            if (res !== false) {
              /** 设置冷却cd */
              this.setLimit(e)
              if (v.log !== false)
                logger.mark(
                  `${e.logFnc} ${lodash.truncate(e.msg, { length: 100 })} 处理完成 ${Date.now() - start}ms`,
                )
              break a
            }
          } catch (error) {
            logger.error(`${e.logFnc}`)
            logger.error(error.stack)
            break a
          }
        }
    }
  }

  /** 过滤事件 */
  filtEvent(e, v) {
    if (!v.event) return false
    const event = v.event.split(".")
    const eventMap = this.eventMap[e.post_type] || []
    const newEvent = []
    for (const i in event) {
      if (event[i] == "*") newEvent.push(event[i])
      else newEvent.push(e[eventMap[i]])
    }
    return v.event == newEvent.join(".")
  }

  /** 判断权限 */
  filtPermission(e, v) {
    if (v.permission == "all" || !v.permission) return true

    if (v.permission == "master") {
      if (e.isMaster) {
        return true
      } else {
        e.reply("暂无权限，只有主人才能操作")
        return false
      }
    }

    if (e.isGroup) {
      if (!e.member?._info) {
        e.reply("数据加载中，请稍后再试")
        return false
      }
      if (v.permission == "owner") {
        if (!e.member.is_owner) {
          e.reply("暂无权限，只有群主才能操作")
          return false
        }
      }
      if (v.permission == "admin") {
        if (!e.member.is_admin) {
          e.reply("暂无权限，只有管理员才能操作")
          return false
        }
      }
    }

    return true
  }

  /**
   * 处理消息，加入自定义字段
   * @param e.msg 文本消息，多行会自动拼接
   * @param e.img 图片消息数组
   * @param e.atBot 是否at机器人
   * @param e.at 是否at，多个at 以最后的为准
   * @param e.file 接受到的文件
   * @param e.isPrivate 是否私聊
   * @param e.isGroup 是否群聊
   * @param e.isMaster 是否管理员
   * @param e.logText 日志用户字符串
   * @param e.logFnc  日志方法字符串

   * 频道
   * @param e.isGuild 是否频道
   * @param e.at 支持频道 tiny_id
   * @param e.atBot 支持频道

   */
  dealMsg(e) {
    if (e.message) {
      for (let val of e.message) {
        switch (val.type) {
          case "text":
            e.msg =
              (e.msg || "") +
              (val.text || "")
                .replace(/^\s*[＃井#]+\s*/, "#")
                .replace(/^\s*[\\*※＊]+\s*/, "*")
                .trim()
            break
          case "image":
            if (!e.img) {
              e.img = []
            }
            e.img.push(val.url)
            break
          case "at":
            if (val.qq == e.bot.uin) {
              e.atBot = true
            } else if (e.bot.tiny_id && val.id == e.bot.tiny_id) {
              e.atBot = true
              /** 多个at 以最后的为准 */
            } else if (val.id) {
              e.at = val.id
            } else {
              e.at = val.qq
            }
            break
          case "file":
            e.file = { name: val.name, fid: val.fid }
            break
          case "xml":
          case "json":
            e.msg =
              (e.msg || "") + (typeof val.data == "string" ? val.data : JSON.stringify(val.data))
            break
        }
      }
    }

    e.logText = ""

    if (e.message_type === "private" || e.notice_type === "friend") {
      e.isPrivate = true

      if (e.sender) {
        e.sender.card = e.sender.nickname
      } else {
        e.sender = {
          card: e.friend?.nickname,
          nickname: e.friend?.nickname,
        }
      }

      e.logText = `[私聊][${e.sender.nickname}(${e.user_id})]`
    }

    if (e.message_type === "group" || e.notice_type === "group") {
      e.isGroup = true
      if (e.sender) {
        e.sender.card = e.sender.card || e.sender.nickname
      } else if (e.member) {
        e.sender = {
          card: e.member.card || e.member.nickname,
        }
      } else if (e.nickname) {
        e.sender = {
          card: e.nickname,
          nickname: e.nickname,
        }
      } else {
        e.sender = {
          card: "",
          nickname: "",
        }
      }

      if (!e.group_name) e.group_name = e.group?.name

      e.logText = `[${e.group_name}(${e.sender.card})]`
    } else if (e.detail_type === "guild") {
      e.isGuild = true
    }

    if (e.user_id && cfg.masterQQ.includes(Number(e.user_id) || String(e.user_id))) {
      e.isMaster = true
    }

    /** 只关注主动at msg处理 */
    if (e.msg && e.isGroup) {
      let groupCfg = cfg.getGroup(e.group_id)
      let alias = groupCfg.botAlias
      if (!Array.isArray(alias)) {
        alias = [alias]
      }
      for (let name of alias) {
        if (e.msg.startsWith(name)) {
          e.msg = lodash.trimStart(e.msg, name).trim()
          e.hasAlias = true
          break
        }
      }
    }
  }

  /** 处理回复,捕获发送失败异常 */
  reply(e) {
    if (e.reply) {
      e.replyNew = e.reply

      /**
       * @param msg 发送的消息
       * @param quote 是否引用回复
       * @param data.recallMsg 群聊是否撤回消息，0-120秒，0不撤回
       * @param data.at 是否at用户
       */
      e.reply = async (msg = "", quote = false, data = {}) => {
        if (!msg) return false

        /** 禁言中 */
        if (e.isGroup && e?.group?.mute_left > 0) return false

        let { recallMsg = 0, at = "" } = data

        if (at && e.isGroup) {
          let text = ""
          if (e?.sender?.card) {
            text = lodash.truncate(e.sender.card, { length: 10 })
          }
          if (at === true) {
            at = Number(e.user_id) || String(e.user_id)
          } else if (!isNaN(at)) {
            if (e.isGuild) {
              text = e.sender?.nickname
            } else {
              let info = e.group.pickMember(at).info
              text = info?.card ?? info?.nickname
            }
            text = lodash.truncate(text, { length: 10 })
          }

          if (Array.isArray(msg)) msg.unshift(segment.at(at, text), "\n")
          else msg = [segment.at(at, text), "\n", msg]
        }

        let msgRes
        try {
          msgRes = await e.replyNew(msg, quote)
        } catch (err) {
          if (typeof msg != "string") {
            if (msg.type == "image" && Buffer.isBuffer(msg?.file)) msg.file = {}
            msg = lodash.truncate(JSON.stringify(msg), { length: 300 })
          }
          logger.error(`发送消息错误:${msg}`)
          logger.error(err)
          if (cfg.bot.sendmsg_error)
            Bot[Bot.uin].pickUser(cfg.masterQQ[0]).sendMsg(`发送消息错误:${msg}`)
        }

        // 频道一下是不是频道
        if (!e.isGuild && recallMsg > 0 && msgRes?.message_id) {
          if (e.isGroup) {
            setTimeout(() => e.group.recallMsg(msgRes.message_id), recallMsg * 1000)
          } else if (e.friend) {
            setTimeout(() => e.friend.recallMsg(msgRes.message_id), recallMsg * 1000)
          }
        }

        this.count(e, msg)
        return msgRes
      }
    } else {
      e.reply = async (msg = "", quote = false, data = {}) => {
        if (!msg) return false
        this.count(e, msg)
        if (e.group_id) {
          return await e.group.sendMsg(msg).catch(err => {
            logger.warn(err)
          })
        } else {
          let friend = e.bot.fl.get(e.user_id)
          if (!friend) return
          return await e.bot
            .pickUser(e.user_id)
            .sendMsg(msg)
            .catch(err => {
              logger.warn(err)
            })
        }
      }
    }
  }

  count(e, msg) {
    let screenshot = false
    if (msg && msg?.file && Buffer.isBuffer(msg?.file)) {
      screenshot = true
    }

    this.saveCount("sendMsg")
    if (screenshot) this.saveCount("screenshot")

    if (e.group_id) {
      this.saveCount("sendMsg", e.group_id)
      if (screenshot) this.saveCount("screenshot", e.group_id)
    }
  }

  saveCount(type, groupId = "") {
    let key = "Yz:count:"

    if (groupId) {
      key += `group:${groupId}:`
    }

    let dayKey = `${key}${type}:day:${moment().format("MMDD")}`
    let monthKey = `${key}${type}:month:${Number(moment().month()) + 1}`
    let totalKey = `${key}${type}:total`

    redis.incr(dayKey)
    redis.incr(monthKey)
    if (!groupId) redis.incr(totalKey)
    redis.expire(dayKey, 3600 * 24 * 30)
    redis.expire(monthKey, 3600 * 24 * 30)
  }

  delCount() {
    let key = "Yz:count:"
    redis.set(`${key}sendMsg:total`, "0")
    redis.set(`${key}screenshot:total`, "0")
  }

  /** 收集定时任务 */
  collectTask(task) {
    for (const i of Array.isArray(task) ? task : [task]) if (i.cron && i.name) this.task.push(i)
  }

  /** 创建定时任务 */
  createTask() {
    for (const i of this.task)
      i.job = schedule.scheduleJob(i.cron, async () => {
        try {
          if (i.log == true) logger.mark(`开始定时任务：${i.name}`)
          await i.fnc()
          if (i.log == true) logger.mark(`定时任务完成：${i.name}`)
        } catch (error) {
          logger.error(`定时任务报错：${i.name}`)
          logger.error(error)
        }
      })
  }

  /** 检查命令冷却cd */
  checkLimit(e) {
    /** 禁言中 */
    if (e.isGroup && e?.group?.mute_left > 0) return false
    if (!e.message || e.isPrivate) return true

    let config = cfg.getGroup(e.group_id)

    if (config.groupGlobalCD && this.groupGlobalCD[e.group_id]) {
      return false
    }
    if (config.singleCD && this.singleCD[`${e.group_id}.${e.user_id}`]) {
      return false
    }

    let { msgThrottle } = this

    let msgId = e.user_id + ":" + e.raw_message
    if (msgThrottle[msgId]) {
      return false
    }
    msgThrottle[msgId] = true
    setTimeout(() => {
      delete msgThrottle[msgId]
    }, 200)

    return true
  }

  /** 设置冷却cd */
  setLimit(e) {
    if (!e.message || e.isPrivate) return
    let config = cfg.getGroup(e.group_id)

    if (config.groupGlobalCD) {
      this.groupGlobalCD[e.group_id] = true
      setTimeout(() => {
        delete this.groupGlobalCD[e.group_id]
      }, config.groupGlobalCD)
    }
    if (config.singleCD) {
      let key = `${e.group_id}.${e.user_id}`
      this.singleCD[key] = true
      setTimeout(() => {
        delete this.singleCD[key]
      }, config.singleCD)
    }
  }

  /** 是否只关注主动at */
  onlyReplyAt(e) {
    if (!e.message || e.isPrivate) return true

    let groupCfg = cfg.getGroup(e.group_id)

    /** 模式0，未开启前缀 */
    if (groupCfg.onlyReplyAt == 0 || !groupCfg.botAlias) return true

    /** 模式2，非主人需带前缀或at机器人 */
    if (groupCfg.onlyReplyAt == 2 && e.isMaster) return true

    /** at机器人 */
    if (e.atBot) return true

    /** 消息带前缀 */
    if (e.hasAlias) return true

    return false
  }

  /** 判断频道消息 */
  checkGuildMsg(e) {
    return cfg.getOther().disableGuildMsg && e.detail_type == "guild"
  }

  /** 判断黑白名单 */
  checkBlack(e) {
    const other = cfg.getOther()

    /** 黑名单qq */
    if (other.blackQQ?.length) {
      if (other.blackQQ.includes(Number(e.user_id) || String(e.user_id))) return false
      if (e.at && other.blackQQ.includes(Number(e.at) || String(e.at))) return false
    }
    /** 白名单qq */
    if (other.whiteQQ?.length)
      if (!other.whiteQQ.includes(Number(e.user_id) || String(e.user_id))) return false

    if (e.group_id) {
      /** 黑名单群 */
      if (
        other.blackGroup?.length &&
        other.blackGroup.includes(Number(e.group_id) || String(e.group_id))
      )
        return false
      /** 白名单群 */
      if (
        other.whiteGroup?.length &&
        !other.whiteGroup.includes(Number(e.group_id) || String(e.group_id))
      )
        return false
    }

    return true
  }

  /** 判断是否启用功能 */
  checkDisable(p) {
    const groupCfg = cfg.getGroup(p.e.group_id)
    if (groupCfg.disable?.length && groupCfg.disable.includes(p.name)) return false
    if (groupCfg.enable?.length && !groupCfg.enable.includes(p.name)) return false
    return true
  }

  async changePlugin(key) {
    try {
      let app = await import(`../../${this.dir}/${key}?${moment().format("x")}`)
      if (app.apps) app = { ...app.apps }
      lodash.forEach(app, p => {
        const plugin = new p()
        for (const i in this.priority)
          if (this.priority[i].key == key && this.priority[i].name == plugin.name) {
            this.priority[i].class = p
            this.priority[i].priority = plugin.priority
          }
        if (plugin.handler) {
          lodash.forEach(plugin.handler, ({ fn, key: handlerKey, priority }) => {
            Handler.add({
              ns: plugin.namespace || key,
              key: handlerKey,
              self: plugin,
              priority: priority ?? plugin.priority,
              fn: plugin[fn],
            })
          })
        }
      })
      this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])
    } catch (error) {
      logger.error(`加载插件错误：${logger.red(key)}`)
      logger.error(decodeURI(error.stack))
    }
  }

  /** 监听热更新 */
  watch(dirName, appName) {
    this.watchDir(dirName)
    if (this.watcher[`${dirName}.${appName}`]) return

    const file = `./${this.dir}/${dirName}/${appName}`
    const watcher = chokidar.watch(file)
    const key = `${dirName}/${appName}`

    /** 监听修改 */
    watcher.on("change", path => {
      logger.mark(`[修改插件][${dirName}][${appName}]`)
      this.changePlugin(key)
    })

    /** 监听删除 */
    watcher.on("unlink", async path => {
      logger.mark(`[卸载插件][${dirName}][${appName}]`)
      /** 停止更新监听 */
      this.watcher[`${dirName}.${appName}`].removeAllListeners("change")
      for (let i = this.priority.length - 1; i >= 0; i--) {
        if (this.priority[i].key === key) {
          const info = this.priority.splice(i, 1)[0]
          const plugin = new info.class()
          if (plugin.handler) {
            lodash.forEach(plugin.handler, ({ key: handlerKey }) => {
              Handler.del(plugin.namespace || key, handlerKey)
            })
          }
        }
      }
    })
    this.watcher[`${dirName}.${appName}`] = watcher
  }

  /** 监听文件夹更新 */
  watchDir(dirName) {
    if (this.watcher[dirName]) return
    const watcher = chokidar.watch(`./${this.dir}/${dirName}/`)
    /** 热更新 */
    setTimeout(() => {
      /** 新增文件 */
      watcher.on("add", async PluPath => {
        const appName = path.basename(PluPath)
        if (!appName.endsWith(".js")) return
        logger.mark(`[新增插件][${dirName}][${appName}]`)
        const key = `${dirName}/${appName}`
        await this.importPlugin({
          name: key,
          path: `../../${this.dir}/${key}?${moment().format("X")}`,
        })
        /** 优先级排序 */
        this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])
        this.watch(dirName, appName)
      })
    }, 10000)
    this.watcher[dirName] = watcher
  }
}
export default new PluginsLoader()

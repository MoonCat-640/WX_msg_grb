/**
 * 模拟数据后端
 * ------------------------------------------------------------------
 * 需求要求「提供模拟数据模式，无需真实微信环境即可测试 UI」。这里的返回结构
 * 与 wechat_exp 的 HTTP 接口**逐字对齐**，这样上层无需分支即可在 mock 与真实
 * 服务之间切换。
 *
 * 重要约定：
 *   - 所有时间戳都是**写死的秒级常量**（以 2026-09-01 为基准手工推算），
 *     **绝不使用 Date.now() 动态生成** —— 保证每次运行数据完全一致、可复现。
 *   - 数据贴近真实校园场景：包含 3~4 个明确的「任务发布」（竞赛报名、材料提交、
 *     会议/培训通知），带起止时间、联系人、所需材料、共享表格链接；同时混入
 *     闲聊、图片、文件、链接、系统消息、引用回复等噪声，用来检验 LLM 抽取的抗噪能力。
 */

import type { RawAccount, RawAddressBookResponse, RawContact, RawMediaInfo, RawMessage } from './types'

/* ==================================================================
 * 时间基准
 * ================================================================== */

/** 2026-09-01 00:00:00（UTC+8）的 Unix 秒。写死常量，保证可复现 */
const D0 = 1788192000

/** 构造「2026 年 9 月第 day 天 hh:mm:ss」的 Unix 秒 */
function sec(day: number, hour = 0, minute = 0, second = 0): number {
  return D0 + (day - 1) * 86400 + hour * 3600 + minute * 60 + second
}

/* ==================================================================
 * 工具：让消息字面量更紧凑
 * ================================================================== */

interface MockMsgInput {
  id: number
  /** Unix 秒 */
  at: number
  /** msg_type */
  kind: number
  /** content / content_raw（非文本消息一般留空，信息放 xml 里） */
  text?: string
  self?: boolean
  who?: string
  wxid?: string
  side?: 'me' | 'other' | 'system' | 'unknown'
  xml?: Record<string, unknown>
  media?: RawMediaInfo
}

function m(i: MockMsgInput): RawMessage {
  const self = i.self ?? false
  return {
    id: i.id,
    msg_type: i.kind,
    is_sender: self,
    sender_name: i.who ?? (self ? '我' : '未知'),
    sender_wxid: i.wxid ?? null,
    sender_side: i.side ?? (self ? 'me' : 'other'),
    sender_evidence: self ? 'origin' : 'prefix',
    content: i.text ?? '',
    content_raw: i.text ?? '',
    create_time: i.at,
    xml_parsed: i.xml ?? {},
    real_sender_id: 0,
    media_info: i.media ?? null
  }
}

/* ==================================================================
 * 会话（4 个群聊 + 2 个联系人）
 * ================================================================== */

const CS3 = 'mock_cs3_2026@chatroom' // 2026级计科3班通知群
const OFFICE = 'mock_office_2026@chatroom' // 学院办公室
const YOUTH = 'mock_youth_2026@chatroom' // 校团委
const LAB = 'mock_lab_2026@chatroom' // 创新实验室
const ZHANG = 'wxid_zhangming_2026' // 张明
const LI = 'wxid_lilaoshi_2026' // 李老师

export const MOCK_CONTACTS: RawContact[] = [
  {
    id: CS3,
    name: '2026级计科3班通知群',
    type: 'group',
    last_msg_time: sec(8, 9, 0, 0),
    msg_count: 26,
    avatar_url: `/api/avatar/${CS3}`
  },
  {
    id: OFFICE,
    name: '学院办公室',
    type: 'group',
    last_msg_time: sec(9, 8, 0, 0),
    msg_count: 18,
    avatar_url: `/api/avatar/${OFFICE}`
  },
  {
    id: YOUTH,
    name: '校团委',
    type: 'group',
    last_msg_time: sec(10, 9, 5, 0),
    msg_count: 16,
    avatar_url: `/api/avatar/${YOUTH}`
  },
  {
    id: LAB,
    name: '创新实验室',
    type: 'group',
    last_msg_time: sec(13, 9, 0, 0),
    msg_count: 15,
    avatar_url: `/api/avatar/${LAB}`
  },
  {
    id: ZHANG,
    name: '张明',
    type: 'user',
    last_msg_time: sec(9, 10, 0, 0),
    msg_count: 15,
    avatar_url: `/api/avatar/${ZHANG}`
  },
  {
    id: LI,
    name: '李老师',
    type: 'user',
    last_msg_time: sec(7, 8, 46, 0),
    msg_count: 2,
    avatar_url: `/api/avatar/${LI}`
  }
]

/* ==================================================================
 * 消息
 * ================================================================== */

const CS3_MESSAGES: RawMessage[] = [
  m({
    id: 1,
    at: sec(1, 8, 30),
    kind: 10000,
    who: '系统消息',
    side: 'system',
    xml: { text: '[系统] "王芳"邀请"刘洋"加入了群聊', sysmsg_type: 'group_member' }
  }),
  m({
    id: 2,
    at: sec(1, 8, 31),
    kind: 1,
    who: '张明',
    wxid: ZHANG,
    text: '各位同学早上好，新学期第一周的通知我整理在群公告里了，请大家抽空看一下～'
  }),
  m({ id: 3, at: sec(1, 9, 5), kind: 1, who: '王芳', wxid: 'wxid_wangfang_2026', text: '收到' }),
  m({ id: 4, at: sec(1, 9, 6), kind: 1, who: '刘洋', wxid: 'wxid_liuyang_2026', text: '收到收到' }),
  m({
    id: 5,
    at: sec(1, 10, 20),
    kind: 1,
    who: '李老师',
    wxid: LI,
    text: '提醒一下，明天上午的《高等数学》调整到 3 教 305，别走错教室。'
  }),
  m({ id: 6, at: sec(1, 10, 21), kind: 1, self: true, text: '好的老师' }),
  m({
    id: 7,
    at: sec(2, 12, 15),
    kind: 3,
    who: '张明',
    wxid: ZHANG,
    xml: { text: '[图片]', width: 1080, height: 1920 },
    media: { media_type: 3, local_path: 'msg/attach/mock/img_001.jpg', width: 1080, height: 1920 }
  }),
  m({ id: 8, at: sec(2, 12, 16), kind: 1, who: '王芳', wxid: 'wxid_wangfang_2026', text: '哈哈哈哈这图谁做的' }),
  m({ id: 9, at: sec(2, 12, 20), kind: 47, who: '刘洋', wxid: 'wxid_liuyang_2026', xml: { text: '[表情]', md5: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' } }),
  m({
    id: 10,
    at: sec(3, 15, 40),
    kind: 6,
    who: '张明',
    wxid: ZHANG,
    xml: { text: '[文件] 2026级计科3班-课程表.xlsx', title: '2026级计科3班-课程表.xlsx', ext: 'xlsx', size: 24576 },
    media: { media_type: 6, file_name: '2026级计科3班-课程表.xlsx', file_size: 24576, local_path: 'msg/attach/mock/课表.xlsx' }
  }),
  m({ id: 11, at: sec(3, 15, 41), kind: 1, who: '张明', wxid: ZHANG, text: '最新的课程表发群里了，大家自行下载' }),
  m({
    id: 12,
    at: sec(4, 9, 10),
    kind: 49,
    who: '李老师',
    wxid: LI,
    xml: {
      render_type: 'link',
      app_type: 5,
      text: '[链接] 关于开展2026年校园安全知识竞赛的通知',
      title: '关于开展2026年校园安全知识竞赛的通知',
      url: 'https://www.example.edu.cn/notice/safety-2026',
      des: '为增强同学们的安全意识，学校决定举办校园安全知识竞赛。',
      appname: '校园通知'
    }
  }),
  m({
    id: 13,
    at: sec(4, 9, 11),
    kind: 1,
    who: '李老师',
    wxid: LI,
    text: '上面这个竞赛自愿参加，报名截止 9 月 20 日'
  }),
  m({
    id: 14,
    at: sec(5, 10, 12),
    kind: 1,
    who: '张明',
    wxid: ZHANG,
    text:
      '【重要】全国大学生数学建模竞赛报名开始啦！想参加的同学请在 9 月 20 日 17:00 前填写下面的共享表格报名：https://docs.qq.com/sheet/mock-math-2026 ，并准备好学生证照片。有问题找 @张明 。'
  }),
  m({
    id: 15,
    at: sec(5, 10, 13),
    kind: 49,
    who: '张明',
    wxid: ZHANG,
    xml: {
      render_type: 'link',
      app_type: 4,
      text: '[链接] 全国大学生数学建模竞赛报名表（共享表格）',
      title: '全国大学生数学建模竞赛报名表（共享表格）',
      url: 'https://docs.qq.com/sheet/mock-math-2026',
      appname: '腾讯文档'
    }
  }),
  m({ id: 16, at: sec(5, 10, 14), kind: 1, who: '王芳', wxid: 'wxid_wangfang_2026', text: '报名+1' }),
  m({ id: 17, at: sec(5, 10, 15), kind: 1, who: '刘洋', wxid: 'wxid_liuyang_2026', text: '组队还差一个人，有想一起的吗' }),
  m({ id: 18, at: sec(5, 11, 2), kind: 1, self: true, text: '我也报，算我一个' }),
  m({
    id: 19,
    at: sec(5, 11, 30),
    kind: 49,
    who: '张明',
    wxid: ZHANG,
    xml: {
      render_type: 'quote',
      app_type: 57,
      text: '[引用] 好的，那你和刘洋组队吧',
      title: '好的，那你和刘洋组队吧',
      quote_content: '我也报，算我一个',
      quote_username: 'wxid_me_2026'
    }
  }),
  m({
    id: 20,
    at: sec(6, 14, 0),
    kind: 3,
    who: '王芳',
    wxid: 'wxid_wangfang_2026',
    xml: { text: '[图片]' },
    media: { media_type: 3, local_path: 'msg/attach/mock/img_002.jpg' }
  }),
  m({
    id: 21,
    at: sec(6, 20, 11),
    kind: 10000,
    who: '系统消息',
    side: 'system',
    xml: { text: '[系统] "张明"撤回了一条消息', sysmsg_type: 'revoke', revoke_content: '你撤回了一条消息' }
  }),
  m({
    id: 22,
    at: sec(7, 8, 45),
    kind: 1,
    who: '李老师',
    wxid: LI,
    text: '关于数学建模补充一句：报名以共享表格填写为准，9 月 20 日 17:00 后不再受理。'
  }),
  m({
    id: 23,
    at: sec(7, 8, 46),
    kind: 1,
    who: '李老师',
    wxid: LI,
    text: '需要的材料：共享表格填写 + 学生证照片（上传到表格对应列）'
  }),
  m({ id: 24, at: sec(7, 12, 0), kind: 1, who: '刘洋', wxid: 'wxid_liuyang_2026', text: '中午一起吃食堂吗' }),
  m({ id: 25, at: sec(7, 12, 5), kind: 1, who: '王芳', wxid: 'wxid_wangfang_2026', text: '来' }),
  m({
    id: 26,
    at: sec(8, 9, 0),
    kind: 1,
    who: '张明',
    wxid: ZHANG,
    text: '另外，本学期第一次班会定在 9 月 12 日 19:00，地点大学生活动中心 201，请准时参加。'
  })
]

const OFFICE_MESSAGES: RawMessage[] = [
  m({ id: 1, at: sec(2, 9, 0), kind: 1, who: '王老师', wxid: 'wxid_wangls_2026', text: '各位老师、助管同学上午好。' }),
  m({
    id: 2,
    at: sec(2, 9, 2),
    kind: 1,
    who: '王老师',
    wxid: 'wxid_wangls_2026',
    text: '【通知】2026-2027学年国家奖学金、励志奖学金材料提交工作现在开始，请各班于 9 月 18 日 17:00 前提交。'
  }),
  m({
    id: 3,
    at: sec(2, 9, 3),
    kind: 6,
    who: '王老师',
    wxid: 'wxid_wangls_2026',
    xml: { text: '[文件] 国家奖学金申请审批表.docx', title: '国家奖学金申请审批表.docx', ext: 'docx', size: 35840 },
    media: { media_type: 6, file_name: '国家奖学金申请审批表.docx', file_size: 35840, local_path: 'msg/attach/mock/审批表.docx' }
  }),
  m({
    id: 4,
    at: sec(2, 9, 4),
    kind: 1,
    who: '王老师',
    wxid: 'wxid_wangls_2026',
    text: '需要提交的材料：①《国家奖学金申请审批表》②成绩单 PDF ③获奖证书扫描件。打包压缩后发到指定邮箱。'
  }),
  m({
    id: 5,
    at: sec(2, 9, 5),
    kind: 49,
    who: '王老师',
    wxid: 'wxid_wangls_2026',
    xml: {
      render_type: 'link',
      app_type: 4,
      text: '[链接] 奖学金材料提交登记表（共享表格）',
      title: '奖学金材料提交登记表（共享表格）',
      url: 'https://docs.qq.com/sheet/mock-scholarship-2026',
      appname: '腾讯文档'
    }
  }),
  m({
    id: 6,
    at: sec(2, 9, 6),
    kind: 1,
    who: '王老师',
    wxid: 'wxid_wangls_2026',
    text: '材料清单和登记表都在上面这个链接里，填写登记表即视为报名。'
  }),
  m({ id: 7, at: sec(2, 9, 10), kind: 1, who: '赵老师', wxid: 'wxid_zhaols_2026', text: '收到' }),
  m({ id: 8, at: sec(2, 9, 11), kind: 1, self: true, text: '收到，请问成绩单需要教务处盖章吗' }),
  m({ id: 9, at: sec(2, 9, 20), kind: 1, who: '王老师', wxid: 'wxid_wangls_2026', text: '需要，去行政楼 3 楼教务处打印盖章。' }),
  m({
    id: 10,
    at: sec(2, 10, 0),
    kind: 3,
    who: '赵老师',
    wxid: 'wxid_zhaols_2026',
    xml: { text: '[图片]' },
    media: { media_type: 3, local_path: 'msg/attach/mock/img_form.jpg' }
  }),
  m({
    id: 11,
    at: sec(3, 14, 22),
    kind: 10000,
    who: '系统消息',
    side: 'system',
    xml: { text: '[系统] "王老师"置顶了一条消息', sysmsg_type: 'pin_msg', operator: '王老师', op: '1' }
  }),
  m({
    id: 12,
    at: sec(5, 16, 30),
    kind: 6,
    who: '王老师',
    wxid: 'wxid_wangls_2026',
    xml: { text: '[文件] 2025-2026学年获奖名单.xlsx', title: '2025-2026学年获奖名单.xlsx', ext: 'xlsx', size: 51200 },
    media: { media_type: 6, file_name: '2025-2026学年获奖名单.xlsx', file_size: 51200, local_path: 'msg/attach/mock/名单.xlsx' }
  }),
  m({ id: 13, at: sec(5, 16, 31), kind: 1, who: '王老师', wxid: 'wxid_wangls_2026', text: '名单仅供核对，不作为评奖依据。' }),
  m({ id: 14, at: sec(6, 11, 11), kind: 1, self: true, text: '老师，材料可以线下交到办公室吗' }),
  m({
    id: 15,
    at: sec(6, 11, 15),
    kind: 1,
    who: '王老师',
    wxid: 'wxid_wangls_2026',
    text: '可以，办公室在行政楼 502，工作日 9:00-17:00。'
  }),
  m({
    id: 16,
    at: sec(8, 9, 30),
    kind: 1,
    who: '王老师',
    wxid: 'wxid_wangls_2026',
    text: '再提醒一次，国家奖学金材料 9 月 18 日 17:00 截止，逾期不候。'
  }),
  m({ id: 17, at: sec(8, 9, 31), kind: 1, who: '赵老师', wxid: 'wxid_zhaols_2026', text: '收到' }),
  m({
    id: 18,
    at: sec(9, 8, 0),
    kind: 1,
    who: '王老师',
    wxid: 'wxid_wangls_2026',
    text: '另外本周五下午的全院大会调整到下周一上午 10 点，线上腾讯会议，链接另行通知。'
  })
]

const YOUTH_MESSAGES: RawMessage[] = [
  m({ id: 1, at: sec(3, 10, 0), kind: 1, who: '陈老师', wxid: 'wxid_chenls_2026', text: '各位同学好，迎新晚会志愿者招募正式启动啦！' }),
  m({
    id: 2,
    at: sec(3, 10, 1),
    kind: 1,
    who: '陈老师',
    wxid: 'wxid_chenls_2026',
    text: '招募岗位：场务、引导、后台道具、摄影摄像。服务时间 9 月 20 日 18:00-22:00。'
  }),
  m({
    id: 3,
    at: sec(3, 10, 2),
    kind: 49,
    who: '陈老师',
    wxid: 'wxid_chenls_2026',
    xml: {
      render_type: 'link',
      app_type: 4,
      text: '[链接] 迎新晚会志愿者报名表',
      title: '迎新晚会志愿者报名表',
      url: 'https://docs.qq.com/sheet/mock-volunteer-2026',
      appname: '腾讯文档'
    }
  }),
  m({
    id: 4,
    at: sec(3, 10, 3),
    kind: 1,
    who: '陈老师',
    wxid: 'wxid_chenls_2026',
    text: '请有意向的同学在 9 月 15 日前填写上面的报名表，并加入志愿者 QQ 群。'
  }),
  m({ id: 5, at: sec(3, 10, 5), kind: 1, who: '周敏', wxid: 'wxid_zhoumin_2026', text: '报名+1，可以选摄影吗' }),
  m({ id: 6, at: sec(3, 10, 6), kind: 1, who: '陈老师', wxid: 'wxid_chenls_2026', text: '可以，报名表里勾选即可。' }),
  m({
    id: 7,
    at: sec(4, 9, 30),
    kind: 3,
    who: '吴迪',
    wxid: 'wxid_wudi_2026',
    xml: { text: '[图片]' },
    media: { media_type: 3, local_path: 'msg/attach/mock/img_youth.jpg' }
  }),
  m({ id: 8, at: sec(4, 9, 31), kind: 1, who: '吴迪', wxid: 'wxid_wudi_2026', text: '去年的现场，超燃！' }),
  m({ id: 9, at: sec(4, 9, 40), kind: 47, self: true, xml: { text: '[表情]', md5: 'ffeeddccbbaa99887766554433221100' } }),
  m({
    id: 10,
    at: sec(5, 15, 0),
    kind: 6,
    who: '陈老师',
    wxid: 'wxid_chenls_2026',
    xml: { text: '[文件] 志愿者岗位职责说明.pdf', title: '志愿者岗位职责说明.pdf', ext: 'pdf', size: 102400 },
    media: { media_type: 6, file_name: '志愿者岗位职责说明.pdf', file_size: 102400, local_path: 'msg/attach/mock/志愿者岗位.pdf' }
  }),
  m({ id: 11, at: sec(5, 15, 1), kind: 1, who: '陈老师', wxid: 'wxid_chenls_2026', text: '岗位职责见附件，培训时间另行通知。' }),
  m({ id: 12, at: sec(8, 14, 0), kind: 1, who: '周敏', wxid: 'wxid_zhoumin_2026', text: '请问培训是线上还是线下' }),
  m({ id: 13, at: sec(8, 14, 10), kind: 1, who: '陈老师', wxid: 'wxid_chenls_2026', text: '线下，在大学生活动中心一楼报告厅。' }),
  m({
    id: 14,
    at: sec(10, 9, 0),
    kind: 1,
    who: '陈老师',
    wxid: 'wxid_chenls_2026',
    text: '【会议通知】志愿者培训会定于 9 月 12 日 19:00 在大学生活动中心 201 举行，请已报名的同学务必参加。'
  }),
  m({
    id: 15,
    at: sec(10, 9, 1),
    kind: 1,
    who: '陈老师',
    wxid: 'wxid_chenls_2026',
    text: '参会需要提前 10 分钟签到，记得带校园卡。'
  }),
  m({ id: 16, at: sec(10, 9, 5), kind: 1, who: '周敏', wxid: 'wxid_zhoumin_2026', text: '收到' })
]

const LAB_MESSAGES: RawMessage[] = [
  m({
    id: 1,
    at: sec(11, 9, 0),
    kind: 1,
    who: '孙老师',
    wxid: 'wxid_sunls_2026',
    text: '【通知】实验室安全考试补考安排：未通过的同学请于 9 月 25 日 23:59 前完成线上补考。'
  }),
  m({
    id: 2,
    at: sec(11, 9, 1),
    kind: 49,
    who: '孙老师',
    wxid: 'wxid_sunls_2026',
    xml: {
      render_type: 'mini_program',
      app_type: 33,
      text: '[小程序] 实验室安全考试系统',
      title: '实验室安全考试系统',
      url: 'https://mp.example.com/lab-safety-exam',
      appname: '实验室安全'
    }
  }),
  m({ id: 3, at: sec(11, 9, 2), kind: 1, self: true, text: '收到，今晚就做' }),
  m({
    id: 4,
    at: sec(11, 9, 5),
    kind: 1,
    who: '孙老师',
    wxid: 'wxid_sunls_2026',
    text: '补考只有一次机会，务必认真作答。'
  }),
  m({
    id: 5,
    at: sec(11, 16, 0),
    kind: 1,
    who: '孙老师',
    wxid: 'wxid_sunls_2026',
    text: '另外，实验室本周开放时间为周一至周五 9:00-21:00，周末需要提前预约。'
  }),
  m({ id: 6, at: sec(11, 16, 5), kind: 1, who: '陈晨', wxid: 'wxid_chenchen_2026', text: '收到' }),
  m({
    id: 7,
    at: sec(12, 10, 0),
    kind: 49,
    who: '孙老师',
    wxid: 'wxid_sunls_2026',
    xml: {
      render_type: 'link',
      app_type: 4,
      text: '[链接] 实验室设备预约共享表格',
      title: '实验室设备预约共享表格',
      url: 'https://docs.qq.com/sheet/mock-lab-booking',
      appname: '腾讯文档'
    }
  }),
  m({
    id: 8,
    at: sec(12, 10, 1),
    kind: 1,
    who: '孙老师',
    wxid: 'wxid_sunls_2026',
    text: '需要借用设备的同学，请提前一天在表格里登记。'
  }),
  m({
    id: 9,
    at: sec(12, 14, 20),
    kind: 3,
    who: '李想',
    wxid: 'wxid_lixiang_2026',
    xml: { text: '[图片]' },
    media: { media_type: 3, local_path: 'msg/attach/mock/img_lab.jpg' }
  }),
  m({ id: 10, at: sec(12, 14, 21), kind: 1, who: '李想', wxid: 'wxid_lixiang_2026', text: '新到的显卡装好了，跑分很香' }),
  m({ id: 11, at: sec(12, 15, 0), kind: 1, who: '陈晨', wxid: 'wxid_chenchen_2026', text: '请问服务器可以预约吗' }),
  m({ id: 12, at: sec(12, 15, 5), kind: 1, who: '孙老师', wxid: 'wxid_sunls_2026', text: '可以，用之前先在预约表里登记。' }),
  m({
    id: 13,
    at: sec(13, 8, 30),
    kind: 6,
    who: '孙老师',
    wxid: 'wxid_sunls_2026',
    xml: { text: '[文件] 实验室安全手册.pdf', title: '实验室安全手册.pdf', ext: 'pdf', size: 512000 },
    media: { media_type: 6, file_name: '实验室安全手册.pdf', file_size: 512000, local_path: 'msg/attach/mock/安全手册.pdf' }
  }),
  m({ id: 14, at: sec(13, 8, 31), kind: 1, who: '孙老师', wxid: 'wxid_sunls_2026', text: '安全手册发群里了，新同学务必看一遍。' }),
  m({
    id: 15,
    at: sec(13, 9, 0),
    kind: 10000,
    who: '系统消息',
    side: 'system',
    xml: { text: '[系统] "李想"加入了群聊', sysmsg_type: 'group_member' }
  })
]

const ZHANG_MESSAGES: RawMessage[] = [
  m({ id: 1, at: sec(5, 10, 20), kind: 1, who: '张明', wxid: ZHANG, text: '在吗，数学建模的事你确定报了吗' }),
  m({ id: 2, at: sec(5, 10, 21), kind: 1, self: true, text: '确定了，表格我填过了' }),
  m({ id: 3, at: sec(5, 10, 22), kind: 1, who: '张明', wxid: ZHANG, text: '好，我们三个一队，队名你再想想' }),
  m({ id: 4, at: sec(5, 10, 23), kind: 1, self: true, text: '行' }),
  m({
    id: 5,
    at: sec(6, 9, 0),
    kind: 6,
    who: '张明',
    wxid: ZHANG,
    xml: { text: '[文件] 数学建模往年赛题.zip', title: '数学建模往年赛题.zip', ext: 'zip', size: 20971520 },
    media: { media_type: 6, file_name: '数学建模往年赛题.zip', file_size: 20971520, local_path: 'msg/attach/mock/往年赛题.zip' }
  }),
  m({ id: 6, at: sec(6, 9, 1), kind: 1, who: '张明', wxid: ZHANG, text: '这是往年的题，我们先找找感觉' }),
  m({
    id: 7,
    at: sec(6, 20, 30),
    kind: 49,
    who: '张明',
    wxid: ZHANG,
    xml: {
      render_type: 'link',
      app_type: 5,
      text: '[链接] 全国大学生数学建模竞赛官网',
      title: '全国大学生数学建模竞赛官网',
      url: 'https://www.mcm.edu.cn/',
      appname: 'MCM'
    }
  }),
  m({ id: 8, at: sec(6, 20, 31), kind: 1, who: '张明', wxid: ZHANG, text: '官网说 9 月 20 日 17:00 报名截止，别忘了' }),
  m({ id: 9, at: sec(7, 12, 0), kind: 1, self: true, text: '记得的' }),
  m({ id: 10, at: sec(8, 8, 0), kind: 1, who: '张明', wxid: ZHANG, text: '对了，报名还要交学生证照片，你拍了吗' }),
  m({ id: 11, at: sec(8, 8, 5), kind: 1, self: true, text: '晚上拍' }),
  m({
    id: 12,
    at: sec(8, 8, 6),
    kind: 3,
    who: '张明',
    wxid: ZHANG,
    xml: { text: '[图片]' },
    media: { media_type: 3, local_path: 'msg/attach/mock/img_studentcard.jpg' }
  }),
  m({ id: 13, at: sec(8, 19, 0), kind: 1, self: true, text: '照片传表格里了' }),
  m({ id: 14, at: sec(8, 19, 1), kind: 1, who: '张明', wxid: ZHANG, text: '好的，齐了' }),
  m({ id: 15, at: sec(9, 10, 0), kind: 1, who: '张明', wxid: ZHANG, text: '明天有空的话我们碰一下选题' })
]

export const MOCK_MESSAGES: Record<string, RawMessage[]> = {
  [CS3]: CS3_MESSAGES,
  [OFFICE]: OFFICE_MESSAGES,
  [YOUTH]: YOUTH_MESSAGES,
  [LAB]: LAB_MESSAGES,
  [ZHANG]: ZHANG_MESSAGES
}

/* ==================================================================
 * 取数函数（签名与 client.ts 对应，便于上层统一分支）
 * ================================================================== */

/** 会话/联系人列表（对应 GET /api/contacts） */
export function mockContacts(q?: string): RawContact[] {
  if (!q) return MOCK_CONTACTS.slice()
  const kw = q.toLowerCase()
  return MOCK_CONTACTS.filter(
    (c) => (c.name ?? '').toLowerCase().includes(kw) || (c.id ?? '').toLowerCase().includes(kw)
  )
}

/** 某会话的消息（对应 GET /api/messages 的 messages 数组），按时间升序 */
export function mockMessages(chatId: string, page = 1, perPage = 200): RawMessage[] {
  const all = MOCK_MESSAGES[chatId] ?? []
  // 与真实接口一致：第 1 页最新、页内升序 → 这里用「从尾部往前切页」模拟
  const clampedPerPage = Math.min(200, Math.max(1, perPage))
  const clampedPage = Math.max(1, page)
  const end = all.length - (clampedPage - 1) * clampedPerPage
  if (end <= 0) return []
  const start = Math.max(0, end - clampedPerPage)
  return all.slice(start, end)
}

/** 通讯录（对应 GET /api/address-book），含完整字段 */
export function mockAddressBook(): RawAddressBookResponse {
  const contacts: RawContact[] = MOCK_CONTACTS.map((c) => ({
    ...c,
    wxid: c.id,
    display_name: c.name,
    is_group: c.type === 'group',
    nick_name: c.type === 'user' ? c.name : undefined,
    avatar_url: c.avatar_url
  }))
  return {
    contacts,
    total: contacts.length,
    page: 1,
    per_page: 100,
    total_pages: 1
  }
}

/** 账号扫描（对应 POST /api/backup/scan） */
export function mockScanAccounts(): { accounts: RawAccount[] } {
  return {
    accounts: [
      {
        db_path: 'D:\\xwechat_files\\wxid_mock_2026_10e8\\db_storage',
        wxid: 'wxid_mock_2026',
        mtime: sec(11, 15, 30),
        db_count: 24,
        size_mb: 1280.5
      }
    ]
  }
}

/**
 * 往某个会话末尾追加 1 条**新的**模拟消息（仅用于模拟模式下的「实时更新」演示）。
 *
 * 同步服务会周期性调用它，用户在界面上就能看到新消息与新任务出现。
 *   - 时间戳用 `Date.now()`（这是本文件里**唯一**允许动态取时的地方——真实数据
 *     要求可复现所以写死，而实时演示必须用当下时间才会显得「新」）
 *   - 发送者从该会话已有消息里随机挑一个（保留其身份，可能是「我」）
 *   - 内容从一组像样的中文里随机取（含通知/回复两类）
 *   - chatId 不存在（或该会话没有消息）则什么都不做
 */
export function appendLiveMockMessage(chatId: string): void {
  const list = MOCK_MESSAGES[chatId]
  if (!list || list.length === 0) return

  const NOTICES = [
    '补充一条通知：相关安排如有变动，会第一时间在群里同步，请留意。',
    '刚刚又核对了一遍材料，没有问题，大家按原计划准备即可。',
    '提醒一下，截止时间是按系统时间算的，别卡点提交哦。',
    '新的安排下来了，具体时间地点以这条为准，请相互转告。',
    '收到，我这边先处理一下，有结果了在群里回复。',
    '这个链接我再看一遍，稍后同步确认信息。',
    '好的，麻烦大家确认一下自己是否在名单里。',
    '再补一句：需要提交的材料请打包成一个压缩包，命名用「姓名+学号」。'
  ]

  const withName = list.filter((x) => x.sender_name)
  const base = withName.length > 0 ? withName[Math.floor(Math.random() * withName.length)] : list[list.length - 1]
  const isSelf = base.is_sender === true
  const lastId = list[list.length - 1]?.id ?? list.length
  const content = NOTICES[Math.floor(Math.random() * NOTICES.length)]

  list.push({
    id: lastId + 1,
    msg_type: 1,
    is_sender: isSelf,
    sender_name: base.sender_name ?? (isSelf ? '我' : '未知'),
    sender_wxid: isSelf ? null : base.sender_wxid ?? null,
    sender_side: isSelf ? 'me' : base.sender_side ?? 'other',
    sender_evidence: isSelf ? 'origin' : 'prefix',
    content,
    content_raw: content,
    create_time: Math.floor(Date.now() / 1000),
    xml_parsed: {},
    real_sender_id: 0,
    media_info: null
  })

  // 同步刷新会话元信息，便于界面按「最近消息」重新排序时反映这条新消息
  const contact = MOCK_CONTACTS.find((c) => c.id === chatId)
  if (contact) {
    contact.msg_count = (contact.msg_count ?? 0) + 1
    contact.last_msg_time = Math.floor(Date.now() / 1000)
  }
}

/** 会话统计（对应 GET /api/chat/<id>/stats） */
export function mockChatStats(chatId: string): {
  chat_id: string
  total_messages: number
  date_range: { start: number; end: number }
  sender_distribution: Record<string, { name: string; count: number }>
} {
  const list = MOCK_MESSAGES[chatId] ?? []
  const times = list.map((x) => x.create_time ?? 0).filter((t) => t > 0)
  const dist: Record<string, { name: string; count: number }> = {}
  for (const msg of list) {
    const key = msg.is_sender ? '__self__' : msg.sender_side === 'system' ? '__sys__' : msg.sender_wxid || '__unknown__'
    const name = msg.sender_name || '未知'
    if (!dist[key]) dist[key] = { name, count: 0 }
    dist[key].count++
  }
  return {
    chat_id: chatId,
    total_messages: list.length,
    date_range: {
      start: times.length ? Math.min(...times) : 0,
      end: times.length ? Math.max(...times) : 0
    },
    sender_distribution: dist
  }
}

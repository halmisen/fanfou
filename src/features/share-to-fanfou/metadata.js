export const options = {
  _: {
    defaultValue: true,
    label: '添加「分享到饭否」到网页右键菜单',
  },

  includePageUrl: {
    defaultValue: false,
    label: '分享选中文字时附带网页链接',
    comment: '默认只发送你选中的那段文字。开启后在文字后面补上网页链接。右键菜单在没有选中文字时分享的仍然是「标题 + 链接」，不受此项影响。',
  },
}

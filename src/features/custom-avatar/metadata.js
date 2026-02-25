import { CONTROL_PLACEHOLDER } from '@constants'

export const options = {
  _: {
    defaultValue: true,
    label: '自定义头像（本地）',
  },

  url: {
    defaultValue: '',
    label: `头像地址：${CONTROL_PLACEHOLDER}`,
    comment: '仅在本机生效，只替换当前页面里属于“我的空间”账号的头像。',
    disableCloudSyncing: true,
    controlOptions: {
      type: 'url',
      placeholder: 'https://example.com/avatar.jpg',
      spellCheck: false,
      autoComplete: 'off',
    },
  },
}

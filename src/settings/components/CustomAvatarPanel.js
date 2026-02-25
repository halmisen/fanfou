import { h, Component } from 'preact'
import {
  CUSTOM_AVATAR_OUTPUT_SIZE,
  CUSTOM_AVATAR_STORAGE_KEY,
} from '@features/custom-avatar/constants'

function readFromLocalStorage(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, result => {
      const error = chrome.runtime.lastError

      if (error) {
        reject(new Error(error.message))
      } else {
        resolve(result[key])
      }
    })
  })
}

function writeToLocalStorage(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const error = chrome.runtime.lastError

      if (error) {
        reject(new Error(error.message))
      } else {
        resolve()
      }
    })
  })
}

function removeFromLocalStorage(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      const error = chrome.runtime.lastError

      if (error) {
        reject(new Error(error.message))
      } else {
        resolve()
      }
    })
  })
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()

    image.addEventListener('load', () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }, { once: true })
    image.addEventListener('error', () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('无法读取图片，请尝试其他图片文件'))
    }, { once: true })

    image.src = objectUrl
  })
}

async function cropAndResizeToDataUrl(file) {
  const image = await loadImage(file)
  const cropSize = Math.min(image.naturalWidth, image.naturalHeight)
  const offsetX = (image.naturalWidth - cropSize) / 2
  const offsetY = (image.naturalHeight - cropSize) / 2
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')

  canvas.width = CUSTOM_AVATAR_OUTPUT_SIZE
  canvas.height = CUSTOM_AVATAR_OUTPUT_SIZE

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    image,
    offsetX,
    offsetY,
    cropSize,
    cropSize,
    0,
    0,
    CUSTOM_AVATAR_OUTPUT_SIZE,
    CUSTOM_AVATAR_OUTPUT_SIZE,
  )

  return canvas.toDataURL('image/png')
}

export default class CustomAvatarPanel extends Component {
  state = {
    loading: true,
    working: false,
    previewDataUrl: '',
    error: '',
  }

  componentDidMount() {
    this.refresh()
  }

  refresh = async () => {
    this.setState({ loading: true, error: '' })

    try {
      const storedValue = await readFromLocalStorage(CUSTOM_AVATAR_STORAGE_KEY)
      this.setState({
        loading: false,
        previewDataUrl: typeof storedValue === 'string' ? storedValue : '',
      })
    } catch (error) {
      this.setState({
        loading: false,
        error: error.message || String(error),
      })
    }
  }

  handleFileChange = async event => {
    const file = event.target.files[0]
    event.target.value = ''

    if (!file) return

    if (!file.type.startsWith('image/')) {
      this.setState({ error: '请选择图片文件（PNG/JPG/WebP 等）' })
      return
    }

    this.setState({ working: true, error: '' })

    try {
      const avatarDataUrl = await cropAndResizeToDataUrl(file)

      await writeToLocalStorage(CUSTOM_AVATAR_STORAGE_KEY, avatarDataUrl)
      this.setState({
        working: false,
        previewDataUrl: avatarDataUrl,
      })
    } catch (error) {
      this.setState({
        working: false,
        error: error.message || String(error),
      })
    }
  }

  handleClear = async () => {
    this.setState({ working: true, error: '' })

    try {
      await removeFromLocalStorage(CUSTOM_AVATAR_STORAGE_KEY)
      this.setState({
        working: false,
        previewDataUrl: '',
      })
    } catch (error) {
      this.setState({
        working: false,
        error: error.message || String(error),
      })
    }
  }

  render() {
    const { loading, working, previewDataUrl, error } = this.state

    return (
      <div className="sf-custom-avatar-panel">
        <h4>本地头像上传</h4>
        <p className="sf-custom-avatar-panel__desc">
          上传后将自动居中裁剪并缩放，输出 48x48 的头像显示效果（内部按 {CUSTOM_AVATAR_OUTPUT_SIZE}x{CUSTOM_AVATAR_OUTPUT_SIZE} 生成以保证清晰度）。
        </p>

        <div className="sf-custom-avatar-panel__actions">
          <label className="sf-custom-avatar-panel__upload">
            <input
              type="file"
              accept="image/*"
              disabled={loading || working}
              onChange={this.handleFileChange}
            />
            选择图片
          </label>
          <button
            type="button"
            disabled={loading || working || !previewDataUrl}
            onClick={this.handleClear}
          >
            清除头像
          </button>
          <button
            type="button"
            disabled={working}
            onClick={this.refresh}
          >
            重新读取
          </button>
        </div>

        <div className="sf-custom-avatar-panel__preview">
          { previewDataUrl && <img src={previewDataUrl} alt="自定义头像预览" /> }
          { !previewDataUrl && !loading && <span>暂无自定义头像</span> }
          { loading && <span>正在读取本地头像…</span> }
        </div>

        { error && <p className="sf-custom-avatar-panel__error">⚠️ { error }</p> }
      </div>
    )
  }
}

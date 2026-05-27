/**
 * Resizes a File/Blob to 256×256 WebP using the Canvas API.
 * Returns a data URL string.
 */
export async function resizeImageToWebP(file: File, size = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('Canvas 2D context unavailable'))

      // Cover-fit: crop to square
      const dim = Math.min(img.width, img.height)
      const sx = (img.width - dim) / 2
      const sy = (img.height - dim) / 2
      ctx.drawImage(img, sx, sy, dim, dim, 0, 0, size, size)

      resolve(canvas.toDataURL('image/webp', 0.8))
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }

    img.src = url
  })
}

/** Get initials for avatar placeholder */
export function getInitials(name: string): string {
  return name
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

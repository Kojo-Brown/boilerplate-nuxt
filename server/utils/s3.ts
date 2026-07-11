import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

let _s3: S3Client | undefined

export function useS3(): S3Client {
  if (!_s3) {
    const config = useRuntimeConfig()
    _s3 = new S3Client({
      region: config.awsRegion as string,
      credentials: {
        accessKeyId: config.awsAccessKeyId as string,
        secretAccessKey: config.awsSecretAccessKey as string,
      },
    })
  }
  return _s3
}

export async function uploadToS3(params: {
  key: string
  body: Buffer
  contentType: string
  bucketName: string
}): Promise<string> {
  const s3 = useS3()
  const config = useRuntimeConfig()

  await s3.send(
    new PutObjectCommand({
      Bucket: params.bucketName,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    }),
  )

  return `https://${params.bucketName}.s3.${config.awsRegion as string}.amazonaws.com/${params.key}`
}

export async function getPresignedUploadUrl(params: {
  key: string
  contentType: string
  bucketName: string
  expiresIn?: number
}): Promise<string> {
  const s3 = useS3()

  const command = new PutObjectCommand({
    Bucket: params.bucketName,
    Key: params.key,
    ContentType: params.contentType,
  })

  return getSignedUrl(s3, command, { expiresIn: params.expiresIn ?? 3600 })
}

export async function getPresignedDownloadUrl(params: {
  key: string
  bucketName: string
  expiresIn?: number
}): Promise<string> {
  const s3 = useS3()

  const command = new GetObjectCommand({
    Bucket: params.bucketName,
    Key: params.key,
  })

  return getSignedUrl(s3, command, { expiresIn: params.expiresIn ?? 3600 })
}

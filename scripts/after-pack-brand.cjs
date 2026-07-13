const fs = require('node:fs/promises')
const path = require('node:path')

const PRODUCT_NAME = 'NeoDeskPet'
const COMPANY_NAME = 'nishichengju'
const FILE_DESCRIPTION = 'AI Live2D desktop companion'
const COPYRIGHT = 'Copyright © 2026 nishichengju'

module.exports = async function afterPackBrand(context) {
  if (context.electronPlatformName !== 'win32') return

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico')
  const temporaryPath = `${exePath}.branded`
  const ResEdit = await import('resedit')
  const source = await fs.readFile(exePath)
  const executable = ResEdit.NtExecutable.from(source)
  const resources = ResEdit.NtExecutableResource.from(executable)

  const iconFile = ResEdit.Data.IconFile.from(await fs.readFile(iconPath))
  const iconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)
  const iconGroupId = iconGroups[0]?.id ?? 1
  const iconLanguage = iconGroups[0]?.lang ?? 1033
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    iconGroupId,
    iconLanguage,
    iconFile.icons.map((item) => item.data),
  )

  const version = `${context.packager.appInfo.version}.0`
  const versionInfo = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0]
  if (!versionInfo) throw new Error(`Missing Windows version resource in ${exePath}`)
  versionInfo.setFileVersion(version, 1033)
  versionInfo.setProductVersion(version, 1033)
  versionInfo.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      CompanyName: COMPANY_NAME,
      FileDescription: FILE_DESCRIPTION,
      InternalName: PRODUCT_NAME,
      LegalCopyright: COPYRIGHT,
      OriginalFilename: `${PRODUCT_NAME}.exe`,
      ProductName: PRODUCT_NAME,
    },
  )
  versionInfo.outputToResourceEntries(resources.entries)
  resources.outputResource(executable)

  await fs.writeFile(temporaryPath, Buffer.from(executable.generate()))
  await fs.rm(exePath)
  await fs.rename(temporaryPath, exePath)
  console.log(`[Brand] embedded icon and version metadata into ${path.basename(exePath)}`)
}

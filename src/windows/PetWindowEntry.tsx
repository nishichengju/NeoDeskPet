import { install as installPixiCspSupport } from '@pixi/unsafe-eval'
import { ShaderSystem } from 'pixi.js'
import { PetWindow } from './PetWindow'

installPixiCspSupport({ ShaderSystem })

export default PetWindow

/*
 * engine-sound-worklet.js —— ForzaTech 风格波导引擎声（AudioWorklet）
 *
 * 改编自开源项目 Antonio-R1/engine-sound-generator（MIT License）：
 *   https://github.com/Antonio-R1/engine-sound-generator
 *   Copyright (c) 2021-2022 Antonio-R1
 * 改动（本项目）：
 *   · 合并为单文件自包含 worklet 模块（原仓库按 ES module 拆分 + 依赖 three.js 的非 worklet 路径已剔除）
 *   · 波导长度由主线程按 (sampleRate/44100) 缩放后传入（原版硬编码 44100）
 *   · 低通滤波器 alpha 用 worklet 全局 sampleRate 计算
 *   · process() 三路输出：[0] 进气  [1] 机体振动  [2] 排气尾管（主线程只取 [1]+[2] 混音）
 *
 * 物理模型：每个气缸 = 进气/排气/歧管三段波导（传输线方程的数字波导实现），
 * 进气阀/排气阀按曲柄角开闭（反射系数在开/关两档间切换），点火激励（fuel ignition）
 * 在压缩上止点附近注入脉冲，全体气缸排气汇入直管 -> 消音器（多支路并联） -> 尾管。
 * 音色由气缸数与管路几何决定 —— 这就是六缸/八缸/十二缸听感差异的物理来源。
 */
'use strict';

const SPEED_OF_SOUND = 343; // m/s（多普勒延迟用；本项目暂不启用）

class LowpassFilter {
   constructor(frequency, lastValue = 0.0) {
      this.frequency = frequency;
      this.alpha = 2.0 * Math.PI / sampleRate * frequency /
                   (2.0 * Math.PI / sampleRate * frequency + 1.0);
      this.lastValue = lastValue;
   }

   getFilteredValue(value) {
      this.lastValue = this.lastValue + this.alpha * (value - this.lastValue);
      return this.lastValue;
   }
}

class Cylinder {
   constructor({index,
                intakeWaveguideLength,
                exhaustWaveguideLength,
                extractorWaveguideLength,
                intakeOpenReflectionFactor,
                intakeClosedReflectionFactor,
                exhaustOpenReflectionFactor,
                exhaustClosedReflectionFactor,
                ignitionTime}) {
      this.index = index;
      this.cylinderWaveguide = new Waveguide(10, 0.75, 0.75);
      this.intakeWaveguide = new Waveguide(intakeWaveguideLength, 0.01, intakeOpenReflectionFactor);
      this.exhaustWaveguide = new Waveguide(exhaustWaveguideLength, exhaustClosedReflectionFactor, 0.01);
      this.extractorWaveguide = new Waveguide(extractorWaveguideLength, 0.01, 0.01);
      this.intakeOpenReflectionFactor = intakeOpenReflectionFactor;
      this.intakeClosedReflectionFactor = intakeClosedReflectionFactor;
      this.exhaustOpenReflectionFactor = exhaustOpenReflectionFactor;
      this.exhaustClosedReflectionFactor = exhaustClosedReflectionFactor;
      this.ignitionTime = ignitionTime;
      this.intakeValve = null;
      this.exhaustValve = null;
      this.pistonMotion = null;
      this.fuelIgnition = null;
   }

   updateWaveguidesReflectionValues() {
      this.intakeWaveguide.reflectionFactorRight = this.intakeOpenReflectionFactor * this.intakeValve +
                                                   this.intakeClosedReflectionFactor * (1.0 - this.intakeValve);
      this.cylinderWaveguide.reflectionFactorLeft = this.intakeOpenReflectionFactor * this.intakeValve +
                                                    this.intakeClosedReflectionFactor * (1.0 - this.intakeValve);
      this.exhaustWaveguide.reflectionFactorLeft = this.exhaustOpenReflectionFactor * this.exhaustValve +
                                                   this.exhaustClosedReflectionFactor * (1.0 - this.exhaustValve);
      this.cylinderWaveguide.reflectionFactorRight = this.exhaustOpenReflectionFactor * this.exhaustValve +
                                                     this.exhaustClosedReflectionFactor * (1.0 - this.exhaustValve);
   }

   update(intakeNoise, straightPipeOutputLeft, x) {
      this.exhaustValve = this._exhaustValve(x);
      this.intakeValve = this._intakeValve(x);
      this.pistonMotion = this._pistonMotion(x);
      this.fuelIgnition = this._fuelIgnition(x, this.ignitionTime);
      this.updateWaveguidesReflectionValues();
      intakeNoise = intakeNoise * this.intakeValve;
      const currentCylinderAmplitude = this.pistonMotion * 1.5 + this.fuelIgnition * 5.0;
      this.currentCylinderAmplitude = currentCylinderAmplitude;
      this.exhaustOutputLeft = this.exhaustWaveguide.outputLeft;
      this.exhaustOutputRight = this.exhaustWaveguide.outputRight;
      const extractorOutputLeft = this.extractorWaveguide.outputLeft;
      const extractorOutputRight = this.extractorWaveguide.outputRight;
      const cylinderOutputLeft = this.cylinderWaveguide.outputLeft;
      const cylinderOutputRight = this.cylinderWaveguide.outputRight;
      const intakeOutputLeft = this.intakeWaveguide.outputLeft;
      const intakeOutputRight = this.intakeWaveguide.outputRight;
      this.extractorWaveguide.add(this.exhaustWaveguide.outputRight, straightPipeOutputLeft);
      this.exhaustWaveguide.add(cylinderOutputRight * (1.0 - 0 * this.exhaustWaveguide.reflectionFactorLeft),
                                extractorOutputLeft);
      this.cylinderWaveguide.add(currentCylinderAmplitude + intakeOutputRight * (1.0 - this.intakeWaveguide.reflectionFactorRight),
                                 extractorOutputLeft * (1.0 - this.exhaustWaveguide.reflectionFactorLeft));
      this.intakeWaveguide.add(intakeNoise, cylinderOutputLeft * (1.0 - this.intakeWaveguide.reflectionFactorRight));
   }

   _exhaustValve(x) {
      if (0.75 < x && x < 1.0) {
         return -Math.sin(4.0 * Math.PI * x);
      }
      return 0;
   }

   _intakeValve(x) {
      if (0 < x && x < 0.25) {
         return Math.sin(4.0 * Math.PI * x);
      }
      return 0;
   }

   _pistonMotion(x) {
      return Math.cos(4.0 * Math.PI * x);
   }

   _fuelIgnition(x, t) {
      if (0.0 < x && x < 0.5 * t) {
         return Math.sin(2.0 * Math.PI * (x / t));
      }
      return 0;
   }
}

class Muffler {
   constructor({elementLengths, action}) {
      this.elements = [];
      this.elementsCount = elementLengths.length;
      this.elementsCountInverse = 1.0 / this.elementsCount;
      for (let i = 0; i < elementLengths.length; i++) {
         this.elements[i] = new Waveguide(elementLengths[i], 0.0, action);
      }
      this.outputLeft = 0.0;
      this.outputRight = 0.0;
   }

   update(mufflerInput, outletValue) {
      mufflerInput = this.elementsCountInverse * mufflerInput;
      outletValue = this.elementsCountInverse * outletValue;
      this.outputLeft = 0.0;
      this.outputRight = 0.0;
      for (let i = 0; i < this.elementsCount; i++) {
         this.outputLeft += this.elements[i].outputLeft;
         this.outputRight += this.elements[i].outputRight;
         this.elements[i].add(mufflerInput, outletValue);
      }
   }
}

class DelayLine {
   constructor(length) {
      if (length < 1) {
         throw new Error("The length of the delay line needs to be a positive value.");
      }
      this.data = new Float32Array(length);
      this.index = 0;
   }

   setValues(values, factor) {
      if (this.data.length != values.length) {
         throw Error("The \"values\" array needs to have the same length as the delay line.");
      }
      for (let i = 0; i < values.length; i++) {
         this.data[i] = factor * values[i];
      }
   }

   updateLeft(value) {
      this.data[this.index] = value;
      this.index++;
      if (this.index >= this.data.length) {
         this.index = 0;
      }
   }

   updateRight(value) {
      this.data[this.index] = value;
      this.index--;
      if (this.index < 0) {
         this.index = this.data.length - 1;
      }
   }

   getAtPosition(index) {
      index = this.index + index;
      while (index < 0) {
         index += this.data.length;
      }
      while (index >= this.data.length) {
         index -= this.data.length;
      }
      return this.data[index];
   }
}

class Waveguide {
   constructor(length, reflectionFactorLeft, reflectionFactorRight) {
      this.upper = new DelayLine(length);
      this.lower = new DelayLine(length);
      this.reflectionFactorLeft = reflectionFactorLeft;
      this.reflectionFactorRight = reflectionFactorRight;
      this.maxIndex = length - 1;
      this.outputLeft = 0.0;
      this.outputRight = 0.0;
   }

   add(valueLeft, valueRight) {
      const reflectedValueLeft = this.lower.getAtPosition(0 * this.maxIndex) * this.reflectionFactorLeft;
      this.outputLeft = this.lower.getAtPosition(0 * this.maxIndex) * (1.0 - this.reflectionFactorLeft);
      const reflectedValueRight = this.upper.getAtPosition(0 * this.maxIndex) * this.reflectionFactorRight;
      this.outputRight = this.upper.getAtPosition(0 * this.maxIndex) * (1.0 - this.reflectionFactorRight);
      this.upper.updateRight(valueLeft + reflectedValueLeft);
      this.lower.updateLeft(valueRight + reflectedValueRight);
   }
}

class EngineSoundGenerator extends AudioWorkletProcessor {
   constructor(options) {
      super();
      const processorOptions = options.processorOptions;
      this.secondsPerSample = 1.0 / sampleRate;
      this.rpm = 0.0;
      this.currentRevolution = 0.0;
      this.intakeNoiseLowPassFilter = new LowpassFilter(11000.0);
      this.crankshaftLowPassFilter = new LowpassFilter(75.0);
      this.engineLowPassFilter = new LowpassFilter(125.0);
      this.sound = null;
      this.intakeSound = null;
      this.outletSound = null;
      this.updateParameters({
         cylinderCount: processorOptions.cylinders,
         intakeWaveguideLength: processorOptions.intakeWaveguideLength,
         exhaustWaveguideLength: processorOptions.exhaustWaveguideLength,
         extractorWaveguideLength: processorOptions.extractorWaveguideLength,
         intakeOpenReflectionFactor: processorOptions.intakeOpenReflectionFactor,
         intakeClosedReflectionFactor: processorOptions.intakeClosedReflectionFactor,
         exhaustOpenReflectionFactor: processorOptions.exhaustOpenReflectionFactor,
         exhaustClosedReflectionFactor: processorOptions.exhaustClosedReflectionFactor,
         ignitionTime: processorOptions.ignitionTime,
         straightPipeWaveguideLength: processorOptions.straightPipeWaveguideLength,
         straightPipeReflectionFactor: processorOptions.straightPipeReflectionFactor,
         mufflerElementsLength: processorOptions.mufflerElementsLength,
         action: processorOptions.action,
         outletWaveguideLength: processorOptions.outletWaveguideLength,
         outletReflectionFactor: processorOptions.outletReflectionFactor});
      this.port.onmessage = (event) => {
         this.updateParameters(event.data);
      };
   }

   updateParameters({cylinderCount,
                     intakeWaveguideLength, exhaustWaveguideLength,
                     extractorWaveguideLength,
                     intakeOpenReflectionFactor, intakeClosedReflectionFactor,
                     exhaustOpenReflectionFactor, exhaustClosedReflectionFactor, ignitionTime,
                     straightPipeWaveguideLength, straightPipeReflectionFactor,
                     mufflerElementsLength, action,
                     outletWaveguideLength, outletReflectionFactor}) {
      this.cylinders = [];
      this.cylindersCountInverse = 1.0 / cylinderCount;
      for (let i = 0; i < cylinderCount; i++) {
         this.cylinders.push(new Cylinder({index: i,
                                           intakeWaveguideLength: intakeWaveguideLength,
                                           exhaustWaveguideLength: exhaustWaveguideLength,
                                           extractorWaveguideLength: extractorWaveguideLength,
                                           intakeOpenReflectionFactor: intakeOpenReflectionFactor,
                                           intakeClosedReflectionFactor: intakeClosedReflectionFactor,
                                           exhaustOpenReflectionFactor: exhaustOpenReflectionFactor,
                                           exhaustClosedReflectionFactor: exhaustClosedReflectionFactor,
                                           ignitionTime: ignitionTime}));
      }
      this.straightPipe = new Waveguide(straightPipeWaveguideLength, straightPipeReflectionFactor,
                                        straightPipeReflectionFactor);
      this.muffler = new Muffler({elementLengths: mufflerElementsLength, action: action});
      this.outlet = new Waveguide(outletWaveguideLength, outletReflectionFactor, outletReflectionFactor);
   }

   static get parameterDescriptors() {
      return [{
         name: 'throttle',
         defaultValue: 0.0,
         minValue: 0.0,
         maxValue: 1.0,
         automationRate: 'a-rate'
      }, {
         name: 'rpm',
         defaultValue: 0.0,
         minValue: 0.0,
         automationRate: 'a-rate'
      }];
   }

   _updateSample(index) {
      this.sound[index] = 0.0;
      let intakeNoise = this.intakeNoiseLowPassFilter.getFilteredValue(2.0 * Math.random() - 1.0);
      if (this.rpm < 25.0) {
         intakeNoise = 0;
      }
      const crankshaftValue = this.crankshaftLowPassFilter.getFilteredValue(0.25 * Math.random());
      for (let i = 0; i < this.cylinders.length; i++) {
         const x = this.currentRevolution + i * (this.cylindersCountInverse + crankshaftValue);
         this.cylinders[i].update(intakeNoise, this.straightPipe.outputLeft, x % 1);
         this.sound[index] += this.cylinders[i].cylinderWaveguide.outputLeft;
      }
      this.currentRevolution += this.secondsPerSample * this.rpm / 120.0;
      if (this.currentRevolution > 1.0) {
         this.currentRevolution -= 1.0;
      }
      this.intakeSound[index] = 0;
      for (let i = 0; i < this.cylinders.length; i++) {
         this.intakeSound[index] += this.cylinders[i].intakeWaveguide.outputLeft;
      }
      let straightPipeInput = 0.0;
      for (let i = 0; i < this.cylinders.length; i++) {
         straightPipeInput += this.cylinders[i].extractorWaveguide.outputRight;
      }
      this.straightPipe.add(straightPipeInput, this.muffler.outputLeft);
      this.outlet.add(this.muffler.outputRight, 0.0);
      this.outletSound[index] = this.outlet.outputRight;
      this.muffler.update(this.straightPipe.outputRight, this.outlet.outputLeft);
   }

   process(inputList, outputList, parameters) {
      this.chunkSize = outputList[0][0].length;
      const channelIntake = outputList[0][0];
      const channelEngineBlockVibrations = outputList[1][0];
      const channelOutlet = outputList[2][0];
      this.sound = channelEngineBlockVibrations;
      this.intakeSound = channelIntake;
      this.outletSound = channelOutlet;
      for (let i = 0; i < this.chunkSize; i++) {
         this.throttle = parameters["throttle"].length > 1 ? parameters["throttle"][i] : parameters["throttle"][0];
         this.rpm = parameters["rpm"].length > 1 ? parameters["rpm"][i] : parameters["rpm"][0];
         this._updateSample(i);
      }
      for (let i = 0; i < this.chunkSize; i++) {
         channelEngineBlockVibrations[i] = this.engineLowPassFilter.getFilteredValue(this.sound[i]);
      }
      return true;
   }
}

registerProcessor("forza-engine-processor", EngineSoundGenerator);

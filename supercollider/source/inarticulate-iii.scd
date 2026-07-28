~pnds[\synthDef] = SynthDef(
    \inarticulateIII,
    {
        |
        out = 0,

        baseFreq1 = 100.0,
        baseFreq2 = 200.0,
        baseFreq3 = 300.0,

        gate1 = 0,
        gate2 = 0,
        gate3 = 0,

        x1 = 0.5,
        y1 = 0.5,

        x2 = 0.5,
        y2 = 0.5,

        x3 = 0.5,
        y3 = 0.5,

        couple12 = 0,
        couple13 = 0,
        couple23 = 0,

        positionLag = 0.12,
        couplingLag = 0.12,
        dopplerLag = 0.18,
        gateLag = 0.03,
        pitchShiftLag = 0.12,

        motionReferenceSpeed = 8.0,
        motionDeadzone = 0.04,

        fmMax = 300.0,
        master = 0.25,

        // amp1 / amp2 / amp3 保留现有 OSC 协议命名，
        // 但这里只控制各声部的 PitchShift 变调量，
        // 不控制任何增益。
        amp1 = 0.0,
        amp2 = 0.0,
        amp3 = 0.0
        |

        var base1;
        var base2;
        var base3;

        var fifthRatio;
        var ninthRatio;

        var positionLagTime;
        var couplingLagTime;
        var dopplerLagTime;
        var gateLagTime;
        var pitchShiftLagTime;

        var referenceSpeed;
        var deadzone;
        var fmMaximum;

        var gate1Smooth;
        var gate2Smooth;
        var gate3Smooth;

        var trigger1;
        var trigger2;
        var trigger3;

        var carrier1;
        var carrier2;
        var carrier3;

        var amp1Smooth;
        var amp2Smooth;
        var amp3Smooth;

        var pitchRatio1;
        var pitchRatio2;
        var pitchRatio3;

        var x1Smooth;
        var y1Smooth;

        var x2Smooth;
        var y2Smooth;

        var x3Smooth;
        var y3Smooth;

        var coupling12Smooth;
        var coupling13Smooth;
        var coupling23Smooth;

        var level1;
        var level2;
        var level3;

        var pan1;
        var pan2;
        var pan3;

        var velocityX1;
        var velocityY1;
        var velocityX2;
        var velocityY2;
        var velocityX3;
        var velocityY3;

        var rawSpeed1;
        var rawSpeed2;
        var rawSpeed3;

        var speed1;
        var speed2;
        var speed3;

        var dopplerMax1;
        var dopplerMax2;
        var dopplerMax3;

        var dopplerShift1;
        var dopplerShift2;
        var dopplerShift3;

        var pairDepth12;
        var pairDepth13;
        var pairDepth23;

        var feedback;
        var feedback1;
        var feedback2;
        var feedback3;

        var modulation1;
        var modulation2;
        var modulation3;

        var frequency1;
        var frequency2;
        var frequency3;

        var oscillator1;
        var oscillator2;
        var oscillator3;

        var shifted1;
        var shifted2;
        var shifted3;

        var voice1;
        var voice2;
        var voice3;

        var signal1;
        var signal2;
        var signal3;

        var masterSmooth;

        var reverbInput;
        var reverbSignal;

        var stereo;


        // ----------------------------------------------------
        // 基础频率
        // ----------------------------------------------------

        base1 = baseFreq1.clip(20, 20000);
        base2 = baseFreq2.clip(20, 20000);
        base3 = baseFreq3.clip(20, 20000);

        fifthRatio = 1.4983070779;
        ninthRatio = 2.2449240966;


        // ----------------------------------------------------
        // 参数限制
        // ----------------------------------------------------

        positionLagTime = positionLag.clip(0.005, 2.0);
        couplingLagTime = couplingLag.clip(0.005, 2.0);
        dopplerLagTime = dopplerLag.clip(0.005, 2.0);
        gateLagTime = gateLag.clip(0.005, 2.0);
        pitchShiftLagTime = pitchShiftLag.clip(0.005, 2.0);

        referenceSpeed = motionReferenceSpeed.clip(0.01, 100.0);
        deadzone = motionDeadzone.clip(0.0, 1.0);
        fmMaximum = fmMax.clip(0.0, 2000.0);


        // ----------------------------------------------------
        // Gate 平滑
        // ----------------------------------------------------

        gate1Smooth = Lag.kr(
            gate1.clip(0, 1),
            gateLagTime
        );

        gate2Smooth = Lag.kr(
            gate2.clip(0, 1),
            gateLagTime
        );

        gate3Smooth = Lag.kr(
            gate3.clip(0, 1),
            gateLagTime
        );


        // ----------------------------------------------------
        // 每次触发时随机选择基础频率上方五度或大九度
        //
        // HPZ1 只在 Gate 从 0 变为非零时产生正向触发。
        // TChoose 会保持选择结果，直到下一次触发。
        // ----------------------------------------------------

        trigger1 = HPZ1.kr(
            gate1.clip(0, 1)
        ).max(0);

        trigger2 = HPZ1.kr(
            gate2.clip(0, 1)
        ).max(0);

        trigger3 = HPZ1.kr(
            gate3.clip(0, 1)
        ).max(0);

        carrier1 = TChoose.kr(
            trigger1,
            [
                base1 * fifthRatio,
                base1 * ninthRatio
            ]
        );

        carrier2 = TChoose.kr(
            trigger2,
            [
                base2 * fifthRatio,
                base2 * ninthRatio
            ]
        );

        carrier3 = TChoose.kr(
            trigger3,
            [
                base3 * fifthRatio,
                base3 * ninthRatio
            ]
        );


        // ----------------------------------------------------
        // amp → PitchShift 变调量
        //
        // amp 是连续的 PitchShift 控制量，不进行音阶或整数半音量化。
        // 0.0 → ratio 1.0；1.0 → ratio 2^(16/12) ≈ 2.5198420998。
        // 中间值保持连续的频率比例。
        // ----------------------------------------------------

        amp1Smooth = Lag.kr(
            amp1.clip(0, 1),
            pitchShiftLagTime
        );

        amp2Smooth = Lag.kr(
            amp2.clip(0, 1),
            pitchShiftLagTime
        );

        amp3Smooth = Lag.kr(
            amp3.clip(0, 1),
            pitchShiftLagTime
        );

        pitchRatio1 = amp1Smooth.linexp(
            0.0,
            1.0,
            1.0,
            2.5198420998
        );

        pitchRatio2 = amp2Smooth.linexp(
            0.0,
            1.0,
            1.0,
            2.5198420998
        );

        pitchRatio3 = amp3Smooth.linexp(
            0.0,
            1.0,
            1.0,
            2.5198420998
        );


        // ----------------------------------------------------
        // x/y 平滑
        //
        // OSC 发送的是离散目标值。
        // 这里先将其转换为连续的 control-rate 信号。
        // ----------------------------------------------------

        x1Smooth = Lag.kr(
            x1.clip(0, 1),
            positionLagTime
        );

        y1Smooth = Lag.kr(
            y1.clip(0, 1),
            positionLagTime
        );


        x2Smooth = Lag.kr(
            x2.clip(0, 1),
            positionLagTime
        );

        y2Smooth = Lag.kr(
            y2.clip(0, 1),
            positionLagTime
        );


        x3Smooth = Lag.kr(
            x3.clip(0, 1),
            positionLagTime
        );

        y3Smooth = Lag.kr(
            y3.clip(0, 1),
            positionLagTime
        );


        // ----------------------------------------------------
        // 连接线强度平滑
        //
        // server.js 发出的 stroke 也是离散的 OSC 控制目标。
        // 因此不能直接将 couple12 当作最终调制信号，
        // 而要先通过 Lag.kr 平滑。
        // ----------------------------------------------------

        coupling12Smooth = Lag.kr(
            couple12.clip(0, 1),
            couplingLagTime
        );

        coupling13Smooth = Lag.kr(
            couple13.clip(0, 1),
            couplingLagTime
        );

        coupling23Smooth = Lag.kr(
            couple23.clip(0, 1),
            couplingLagTime
        );


        // ----------------------------------------------------
        // y → 音量
        //
        // y = 0.5 → 1.0
        // y = 0.0 → 0.5
        // y = 1.0 → 0.5
        // ----------------------------------------------------

        level1 = (
            1.0
            - (y1Smooth - 0.5).abs
        );

        level2 = (
            1.0
            - (y2Smooth - 0.5).abs
        );

        level3 = (
            1.0
            - (y3Smooth - 0.5).abs
        );


        // ----------------------------------------------------
        // x → 声相
        //
        // x = 0.0 → -1.0，最左
        // x = 0.5 →  0.0，中间
        // x = 1.0 →  1.0，最右
        // ----------------------------------------------------

        pan1 = x1Smooth.linlin(
            0,
            1,
            -1,
            1
        );

        pan2 = x2Smooth.linlin(
            0,
            1,
            -1,
            1
        );

        pan3 = x3Smooth.linlin(
            0,
            1,
            -1,
            1
        );


        // ----------------------------------------------------
        // 从平滑后的 x/y 计算速度
        // ----------------------------------------------------
        //
        // Slope.kr 输出每秒变化量。
        // 因为 x/y 已经经过 Lag.kr，
        // 这里计算的是平滑轨迹的速度，
        // 而不是原始 OSC 阶梯的瞬时跳变。
        // ----------------------------------------------------

        velocityX1 = Slope.kr(x1Smooth);
        velocityY1 = Slope.kr(y1Smooth);

        velocityX2 = Slope.kr(x2Smooth);
        velocityY2 = Slope.kr(y2Smooth);

        velocityX3 = Slope.kr(x3Smooth);
        velocityY3 = Slope.kr(y3Smooth);


        // ----------------------------------------------------
        // x/y 平面速度大小
        // ----------------------------------------------------

        rawSpeed1 = (
            (
                (velocityX1 * velocityX1)
                + (velocityY1 * velocityY1)
            ).sqrt
        );

        rawSpeed2 = (
            (
                (velocityX2 * velocityX2)
                + (velocityY2 * velocityY2)
            ).sqrt
        );

        rawSpeed3 = (
            (
                (velocityX3 * velocityX3)
                + (velocityY3 * velocityY3)
            ).sqrt
        );


        // ----------------------------------------------------
        // 速度归一化
        //
        // 先减去死区，再除以参考速度。
        // ----------------------------------------------------

        speed1 = (
            (rawSpeed1 - deadzone).max(0)
            / referenceSpeed
        ).clip(0, 1);

        speed2 = (
            (rawSpeed2 - deadzone).max(0)
            / referenceSpeed
        ).clip(0, 1);

        speed3 = (
            (rawSpeed3 - deadzone).max(0)
            / referenceSpeed
        ).clip(0, 1);


        // ----------------------------------------------------
        // 平方曲线
        //
        // 抑制小幅度移动造成的 Doppler。
        //
        // 0.2 → 0.04
        // 0.5 → 0.25
        // 1.0 → 1.00
        // ----------------------------------------------------

        speed1 = speed1 * speed1;
        speed2 = speed2 * speed2;
        speed3 = speed3 * speed3;


        // ----------------------------------------------------
        // 速度平滑
        // ----------------------------------------------------

        speed1 = Lag.kr(
            speed1,
            dopplerLagTime
        );

        speed2 = Lag.kr(
            speed2,
            dopplerLagTime
        );

        speed3 = Lag.kr(
            speed3,
            dopplerLagTime
        );


        // ----------------------------------------------------
        // Doppler 最大偏移
        //
        // 关键公式：
        //
        // dopplerMax1 = base1 * 0.2
        // dopplerMax2 = base2 * 0.2
        // dopplerMax3 = base3 * 0.2
        //
        // 这里的 0.2 是相对于各自基础频率的固定比例。
        // ----------------------------------------------------

        dopplerMax1 = base1 * 0.2;
        dopplerMax2 = base2 * 0.2;
        dopplerMax3 = base3 * 0.2;

        dopplerShift1 = speed1 * dopplerMax1;
        dopplerShift2 = speed2 * dopplerMax2;
        dopplerShift3 = speed3 * dopplerMax3;


        // ----------------------------------------------------
        // 连接线距离 → FM 调制深度
        //
        // 每个连接对的最大深度是 fmMaximum * 0.5。
        //
        // 例如 couple12 = 1：
        // voice 1 和 voice 2 之间使用完整的 pairDepth12。
        //
        // 一个声部最多同时受到两个其他声部影响，
        // 所以乘以 0.5 可以避免两组连接同时最大时
        // 调制深度简单叠加到两倍。
        // ----------------------------------------------------

        pairDepth12 = coupling12Smooth
            * fmMaximum
            * 0.5;

        pairDepth13 = coupling13Smooth
            * fmMaximum
            * 0.5;

        pairDepth23 = coupling23Smooth
            * fmMaximum
            * 0.5;


        // ----------------------------------------------------
        // 互相 FM 反馈
        // ----------------------------------------------------

        feedback = LocalIn.ar(3);

        feedback1 = feedback[0].clip(-1, 1);
        feedback2 = feedback[1].clip(-1, 1);
        feedback3 = feedback[2].clip(-1, 1);


        // voice 1 受到 voice 2 和 voice 3 的调制
        modulation1 = (
            feedback2 * pairDepth12
        ) + (
            feedback3 * pairDepth13
        );


        // voice 2 受到 voice 1 和 voice 3 的调制
        modulation2 = (
            feedback1 * pairDepth12
        ) + (
            feedback3 * pairDepth23
        );


        // voice 3 受到 voice 1 和 voice 2 的调制
        modulation3 = (
            feedback1 * pairDepth13
        ) + (
            feedback2 * pairDepth23
        );


        // ----------------------------------------------------
        // 触发后选定的基础频率
        // + Doppler
        // + 距离驱动的相互 FM
        // ----------------------------------------------------

        frequency1 = (
            carrier1
            + dopplerShift1
            + modulation1
        ).clip(20, 20000);

        frequency2 = (
            carrier2
            + dopplerShift2
            + modulation2
        ).clip(20, 20000);

        frequency3 = (
            carrier3
            + dopplerShift3
            + modulation3
        ).clip(20, 20000);


        // ----------------------------------------------------
        // 三个正弦波振荡器
        // ----------------------------------------------------

        oscillator1 = SinOsc.ar(frequency1, mul:0.8, add: 0.2).tanh;
		oscillator2 = SinOsc.ar(frequency2, mul:0.8, add: 0.2).tanh;
        oscillator3 = SinOsc.ar(frequency3, mul:0.8, add: 0.2).tanh;


        // ----------------------------------------------------
        // 每个声部的 PitchShift
        //
        // PitchShift 版本固定为 -3 dB；amp 只控制变调比例。
        // ----------------------------------------------------

        shifted1 = PitchShift.ar(
            oscillator1,
            0.2,
            pitchRatio1,
            0.0,
            0.01
        );

        shifted2 = PitchShift.ar(
            oscillator2,
            0.2,
            pitchRatio2,
            0.0,
            0.01
        );

        shifted3 = PitchShift.ar(
            oscillator3,
            0.2,
            pitchRatio3,
            0.0,
            0.01
        );

        voice1 = oscillator1 + (shifted1 * 0.707946);
        voice2 = oscillator2 + (shifted2 * 0.707946);
        voice3 = oscillator3 + (shifted3 * 0.707946);


        // ----------------------------------------------------
        // 写回反馈网络
        //
        // 原始声音与 PitchShift 版本的复合信号参与 FM。
        // ----------------------------------------------------

        LocalOut.ar([
            voice1 * gate1Smooth,
            voice2 * gate2Smooth,
            voice3 * gate3Smooth
        ]);


        // ----------------------------------------------------
        // 三个声部的实际输出
        // ----------------------------------------------------

        signal1 = voice1
            * gate1Smooth
            * level1;

        signal2 = voice2
            * gate2Smooth
            * level2;

        signal3 = voice3
            * gate3Smooth
            * level3;


        // ----------------------------------------------------
        // 总音量平滑
        // ----------------------------------------------------

        masterSmooth = Lag.kr(
            master.clip(0, 1),
            0.1
        );


        // ----------------------------------------------------
        // 三个声部进入混响总线
        //
        // 混响位于 master 之前，因此 master 会同时控制
        // 干声与混响返回信号。
        // ----------------------------------------------------

        reverbInput =
            Pan2.ar(signal1, pan1)
            + Pan2.ar(signal2, pan2)
            + Pan2.ar(signal3, pan3);


        // ----------------------------------------------------
        // 内置混响
        //
        // FreeVerb2 是 SuperCollider 自带的立体声混响。
        // 较大的 room 与较高的 damp 让尾音更长、高频更暗，
        // 形成偏浑浊的空间感。
        // ----------------------------------------------------

        reverbSignal = FreeVerb2.ar(
            reverbInput[0],
            reverbInput[1],
            0.5,
            0.88,
            0.82
        );

        stereo = reverbSignal;


        // ----------------------------------------------------
        // 最终输出
        // ----------------------------------------------------

        Out.ar(
            out,
            Limiter.ar(
                stereo * masterSmooth,
                0.95
            )
        );
    }
);

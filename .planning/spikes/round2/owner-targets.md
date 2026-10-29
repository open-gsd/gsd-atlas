# V2 targets for the owner (write 50 queries; skip any you cannot describe)

1. [a:util.d.ts:1915:isBigUint64Array]
   name: isBigUint64Array   (module util)
   declaration: function isBigUint64Array(value: unknown): value is BigUint64Array;
   documentation: Returns `true` if the value is a `BigUint64Array` instance.

2. [a:tslib:lib.dom.d.ts:21638:HTMLTrackElement.srclang]
   name: srclang   (member of HTMLTrackElement)
   declaration: srclang: string;
   documentation: The **`srclang`** property of the HTMLTrackElement interface reflects the value of the <track> element's srclang attribute or the empty string if not defined. [MDN Reference](https://developer.mozilla.org/docs/Web/API/HTMLTrackElement/srclang)

3. [a:module.d.ts:333:stripTypeScriptTypes]
   name: stripTypeScriptTypes   (module module)
   declaration: function stripTypeScriptTypes(code: string, options?: StripTypeScriptTypesOptions): string;
   documentation: `module.stripTypeScriptTypes()` removes type annotations from TypeScript code. It can be used to strip type annotations from TypeScript code before running it with `vm.runInContext()` or `vm.compileFunction()`. By default, it will throw an error if the code contains TypeScript features that require transformation such as `Enums`, see [type-strippin

4. [a:tslib:lib.es2020.bigint.d.ts:239:BigInt64Array.includes]
   name: includes   (member of BigInt64Array)
   declaration: includes(searchElement: bigint, fromIndex?: number): boolean;
   documentation: Determines whether an array includes a certain element, returning true or false as appropriate.

5. [a:tslib:lib.dom.d.ts:13060:Document.execCommand]
   name: execCommand   (member of Document)
   declaration: execCommand(commandId: string, showUI?: boolean, value?: string): boolean;
   documentation: The **`execCommand`** method implements multiple different commands. Some of them provide access to the clipboard, while others are for editing form inputs, contenteditable elements or entire documents (when switched to design mode).

6. [a:timers.d.ts:260:clearTimeout]
   name: clearTimeout   (module timers)
   declaration: function clearTimeout(timeout: NodeJS.Timeout | string | number | undefined): void;
   documentation: Cancels a `Timeout` object created by `setTimeout()`. @since v0.0.1 @param timeout A `Timeout` object as returned by `setTimeout()` or the primitive of the `Timeout` object as a string or a number.

7. [a:tslib:lib.dom.d.ts:4008:AudioContext.AudioContext]
   name: AudioContext   (member of AudioContext)
   declaration: interface AudioContext extends BaseAudioContext {
   documentation: The **`AudioContext`** interface represents an audio-processing graph built from audio modules linked together, each represented by an AudioNode. [MDN Reference](https://developer.mozilla.org/docs/Web/API/AudioContext)

8. [a:tslib:lib.dom.d.ts:29810:RTCRtpSender.setStreams]
   name: setStreams   (member of RTCRtpSender)
   declaration: setStreams(...streams: MediaStream[]): void;
   documentation: The RTCRtpSender method **`setStreams()`** associates the sender's track with the specified MediaStream objects. [MDN Reference](https://developer.mozilla.org/docs/Web/API/RTCRtpSender/setStreams)

9. [a:v8.d.ts:814:Init]
   name: Init   (module v8)
   declaration: interface Init {
   documentation: Called when a promise is constructed. This does not mean that corresponding before/after events will occur, only that the possibility exists. This will happen if a promise is created without ever getting a continuation. @since v17.1.0, v16.14.0 @param promise The promise being created. @param parent The promise continued from, if applicable.

10. [a:tslib:lib.dom.d.ts:43840:MathMLElementTagNameMap.onclick]
   name: onclick   (member of MathMLElementTagNameMap)
   declaration: declare var onclick: ((this: Window, ev: PointerEvent) => any) | null;
   documentation: [MDN Reference](https://developer.mozilla.org/docs/Web/API/Element/click_event)

11. [a:tslib:lib.dom.d.ts:26966:PannerNode.maxDistance]
   name: maxDistance   (member of PannerNode)
   declaration: maxDistance: number;
   documentation: The **`maxDistance`** property of the PannerNode interface is a double value representing the maximum distance between the audio source and the listener, after which the volume is not reduced any further. This value is used only by the linear distance model. [MDN Reference](https://developer.mozilla.org/docs/Web/API/PannerNode/maxDistance)

12. [a:tslib:lib.dom.d.ts:35812:SpeechSynthesisUtterance.rate]
   name: rate   (member of SpeechSynthesisUtterance)
   declaration: rate: number;
   documentation: The **`rate`** property of the SpeechSynthesisUtterance interface gets and sets the speed at which the utterance will be spoken at. [MDN Reference](https://developer.mozilla.org/docs/Web/API/SpeechSynthesisUtterance/rate)

13. [a:net.d.ts:1130:isIPv4]
   name: isIPv4   (module net)
   declaration: function isIPv4(input: string): boolean;
   documentation: Returns `true` if `input` is an IPv4 address in [dot-decimal notation](https://en.wikipedia.org/wiki/Dot-decimal_notation) with no leading zeroes. Otherwise, returns `false`.

14. [a:tslib:lib.dom.d.ts:34676:Screen.availWidth]
   name: availWidth   (member of Screen)
   declaration: readonly availWidth: number;
   documentation: The **`Screen.availWidth`** property returns the amount of horizontal space (in CSS pixels) available to the window. [MDN Reference](https://developer.mozilla.org/docs/Web/API/Screen/availWidth)

15. [a:tslib:lib.dom.d.ts:12880:Document.caretRangeFromPoint]
   name: caretRangeFromPoint   (member of Document)
   declaration: caretRangeFromPoint(x: number, y: number): Range | null;
   documentation: The **`caretRangeFromPoint()`** method of the Document interface returns a Range object for the document fragment under the specified coordinates.

16. [a:tslib:lib.dom.d.ts:43686:MathMLElementTagNameMap.confirm]
   name: confirm   (member of MathMLElementTagNameMap)
   declaration: declare function confirm(message?: string): boolean;
   documentation: **`window.confirm()`** instructs the browser to display a dialog with an optional message, and to wait until the user either confirms or cancels the dialog. [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/confirm)

17. [a:events.d.ts:550:NodeEventTarget]
   name: NodeEventTarget   (module events)
   declaration: export interface NodeEventTarget extends EventTarget {
   documentation: The `NodeEventTarget` is a Node.js-specific extension to `EventTarget` that emulates a subset of the `EventEmitter` API. @since v14.5.0

18. [a:tslib:lib.dom.d.ts:36709:TextTrack.addCue]
   name: addCue   (member of TextTrack)
   declaration: addCue(cue: TextTrackCue): void;
   documentation: The **`addCue()`** method of the TextTrack interface adds a new cue to the list of cues. [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextTrack/addCue)

19. [a:tslib:lib.dom.d.ts:16520:Geolocation.watchPosition]
   name: watchPosition   (member of Geolocation)
   declaration: watchPosition(successCallback: PositionCallback, errorCallback?: PositionErrorCallback | null, options?: PositionOptions): number;
   documentation: The **`watchPosition()`** method of the Geolocation interface is used to register a handler function that will be called automatically each time the position of the device changes. You can also, optionally, specify an error handling callback function. [MDN Reference](https://developer.mozilla.org/docs/Web/API/Geolocation/watchPosition)

20. [a:tslib:lib.dom.d.ts:28302:PictureInPictureEvent.PictureInPictureEvent]
   name: PictureInPictureEvent   (member of PictureInPictureEvent)
   declaration: interface PictureInPictureEvent extends Event {
   documentation: The **`PictureInPictureEvent`** interface represents picture-in-picture-related events, including enterpictureinpicture, leavepictureinpicture and resize. [MDN Reference](https://developer.mozilla.org/docs/Web/API/PictureInPictureEvent)

21. [a:tslib:lib.dom.d.ts:32621:SVGFilterPrimitiveStandardAttributes.height]
   name: height   (member of SVGFilterPrimitiveStandardAttributes)
   declaration: readonly height: SVGAnimatedLength;
   documentation: [MDN Reference](https://developer.mozilla.org/docs/Web/API/SVGFEBlendElement/height)

22. [a:tslib:lib.dom.d.ts:30601:ResizeObserver.ResizeObserver]
   name: ResizeObserver   (member of ResizeObserver)
   declaration: interface ResizeObserver {
   documentation: The **`ResizeObserver`** interface reports changes to the dimensions of an Element's content or border box, or the bounding box of an SVGElement. [MDN Reference](https://developer.mozilla.org/docs/Web/API/ResizeObserver)

23. [a:os.d.ts:161:type]
   name: type   (module os)
   declaration: function type(): string;
   documentation: Returns the operating system name as returned by [`uname(3)`](https://linux.die.net/man/3/uname). For example, it returns `'Linux'` on Linux, `'Darwin'` on macOS, and `'Windows_NT'` on Windows. See [https://en.wikipedia.org/wiki/Uname#Examples](https://en.wikipedia.org/wiki/Uname#Examples) for additional information about the output of running [`un

24. [a:tslib:lib.dom.d.ts:17018:HTMLAllCollection.namedItem]
   name: namedItem   (member of HTMLAllCollection)
   declaration: namedItem(name: string): HTMLCollection | Element | null;
   documentation: The **`namedItem()`** method of the HTMLAllCollection interface returns the first Element in the collection whose id or name attribute matches the specified name, or null if no element matches. [MDN Reference](https://developer.mozilla.org/docs/Web/API/HTMLAllCollection/namedItem)

25. [a:net.d.ts:600:BoundSocket]
   name: BoundSocket   (module net)
   declaration: class BoundSocket {
   documentation: Allows for the synchronous creation of a pre-bound socket, that can be passed to `listen()` or `new net.Socket()` later on. For `listen()` this enables synchronous port reservation, while for `new net.Socket()`, it allows control over the local egress port/IP, via `bind(2)` semantics. Adoption transfers ownership of the socket; afterwards `address(

26. [a:tslib:lib.dom.d.ts:41684:WindowEventHandlers.onrejectionhandled]
   name: onrejectionhandled   (member of WindowEventHandlers)
   declaration: onrejectionhandled: ((this: WindowEventHandlers, ev: PromiseRejectionEvent) => any) | null;
   documentation: [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/rejectionhandled_event)

27. [a:util.d.ts:1173:parseEnv]
   name: parseEnv   (module util)
   declaration: export function parseEnv(content: string): NodeJS.Dict<string>;
   documentation: Stability: 1.1 - Active development Given an example `.env` file:

28. [a:crypto.d.ts:1242:generateKey]
   name: generateKey   (module crypto)
   declaration: function generateKey(
   documentation: Asynchronously generates a new random secret key of the given `length`. The `type` will determine which validations will be performed on the `length`.

29. [a:tslib:lib.dom.d.ts:9217:CSSStyleProperties.transitionTimingFunction]
   name: transitionTimingFunction   (member of CSSStyleProperties)
   declaration: transitionTimingFunction: string;
   documentation: The transition-timing-function CSS property sets how intermediate values are calculated for CSS properties being affected by a transition effect. [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/transition-timing-function)

30. [a:tslib:lib.dom.d.ts:4891:BaseAudioContext.createDelay]
   name: createDelay   (member of BaseAudioContext)
   declaration: createDelay(maxDelayTime?: number): DelayNode;
   documentation: The **`createDelay()`** method of the BaseAudioContext Interface is used to create a DelayNode, which is used to delay the incoming audio signal by a certain amount of time. [MDN Reference](https://developer.mozilla.org/docs/Web/API/BaseAudioContext/createDelay)

31. [a:tslib:lib.scripthost.d.ts:171:TextStreamReader.ScriptName]
   name: ScriptName   (member of TextStreamReader)
   declaration: ScriptName: string;
   documentation: The filename of the currently running script.

32. [a:tslib:lib.dom.d.ts:4630:AudioWorklet.AudioWorklet]
   name: AudioWorklet   (member of AudioWorklet)
   declaration: interface AudioWorklet extends Worklet {
   documentation: The **`AudioWorklet`** interface of the Web Audio API is used to supply custom audio processing scripts that execute in a separate thread to provide very low latency audio processing. Available only in secure contexts. [MDN Reference](https://developer.mozilla.org/docs/Web/API/AudioWorklet)

33. [a:tslib:lib.dom.d.ts:44046:MathMLElementTagNameMap.ongamepaddisconnected]
   name: ongamepaddisconnected   (member of MathMLElementTagNameMap)
   declaration: declare var ongamepaddisconnected: ((this: Window, ev: GamepadEvent) => any) | null;
   documentation: [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/gamepaddisconnected_event)

34. [a:util.d.ts:2094:isInt16Array]
   name: isInt16Array   (module util)
   declaration: function isInt16Array(object: unknown): object is Int16Array;
   documentation: Returns `true` if the value is a built-in [`Int16Array`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Int16Array) instance.

35. [a:punycode.d.ts:64:toUnicode]
   name: toUnicode   (module punycode)
   declaration: function toUnicode(domain: string): string;
   documentation: The `punycode.toUnicode()` method converts a string representing a domain name containing [Punycode](https://tools.ietf.org/html/rfc3492) encoded characters into Unicode. Only the [Punycode](https://tools.ietf.org/html/rfc3492) encoded parts of the domain name are be converted.

36. [a:fs.d.ts:3239:readFileSync]
   name: readFileSync   (module fs)
   declaration: export function readFileSync<T extends NodeJS.ArrayBufferView>(
   documentation: Returns the contents of the `path`. For detailed information, see the documentation of the asynchronous version of this API: `fs.readFile()`. If the `encoding` option is specified then this function returns a string. Otherwise it returns a buffer. If `buffer` is provided and no encoding is specified, the returned {Buffer} is a view over the supplie

37. [a:tslib:lib.dom.d.ts:3272:ARIAMixin.ariaDetailsElements]
   name: ariaDetailsElements   (member of ARIAMixin)
   declaration: ariaDetailsElements: ReadonlyArray<Element> | null;
   documentation: [MDN Reference](https://developer.mozilla.org/docs/Web/API/Element/ariaDetailsElements)

38. [a:tslib:lib.dom.d.ts:42341:XSLTProcessor.transformToFragment]
   name: transformToFragment   (member of XSLTProcessor)
   declaration: transformToFragment(source: Node, output: Document): DocumentFragment;
   documentation: The **`transformToFragment()`** method of the XSLTProcessor interface transforms a provided Node source to a DocumentFragment using the XSLT stylesheet associated with the XSLTProcessor. [MDN Reference](https://developer.mozilla.org/docs/Web/API/XSLTProcessor/transformToFragment)

39. [a:tslib:lib.dom.d.ts:8508:CSSStyleProperties.pageBreakBefore]
   name: pageBreakBefore   (member of CSSStyleProperties)
   declaration: pageBreakBefore: string;
   documentation: The page-break-before CSS property adjusts page breaks before the current element.

40. [a:zlib.d.ts:380:createZstdDecompress]
   name: createZstdDecompress   (module zlib)
   declaration: function createZstdDecompress(options?: ZstdOptions): ZstdDecompress;
   documentation: Creates and returns a new `ZstdDecompress` object. @since v22.15.0

41. [a:util.d.ts:348:setTraceSigInt]
   name: setTraceSigInt   (module util)
   declaration: export function setTraceSigInt(enable: boolean): void;
   documentation: Enable or disable printing a stack trace on `SIGINT`. The API is only available on the main thread. @since 24.6.0

42. [a:fs.d.ts:1507:linkSync]
   name: linkSync   (module fs)
   declaration: export function linkSync(existingPath: PathLike, newPath: PathLike): void;
   documentation: Creates a new link from the `existingPath` to the `newPath`. See the POSIX [`link(2)`](http://man7.org/linux/man-pages/man2/link.2.html) documentation for more detail. Returns `undefined`. @since v0.1.31

43. [a:tslib:lib.dom.d.ts:38234:VisualViewport.pageTop]
   name: pageTop   (member of VisualViewport)
   declaration: readonly pageTop: number;
   documentation: The **`pageTop`** read-only property of the VisualViewport interface returns the y coordinate of the top edge of the visual viewport relative to the initial containing block origin, in CSS pixels, or 0 if current document is not fully active. [MDN Reference](https://developer.mozilla.org/docs/Web/API/VisualViewport/pageTop)

44. [a:tslib:lib.dom.d.ts:5330:CSSCounterStyleRule.speakAs]
   name: speakAs   (member of CSSCounterStyleRule)
   declaration: speakAs: string;
   documentation: The **`speakAs`** property of the CSSCounterStyleRule interface gets and sets the value of the speak-as descriptor. If the descriptor does not have a value set, this attribute returns an empty string. [MDN Reference](https://developer.mozilla.org/docs/Web/API/CSSCounterStyleRule/speakAs)

45. [a:v8.d.ts:993:addDeserializeCallback]
   name: addDeserializeCallback   (module v8)
   declaration: function addDeserializeCallback(callback: StartupSnapshotCallbackFn, data?: any): void;
   documentation: Add a callback that will be called when the Node.js instance is deserialized from a snapshot. The `callback` and the `data` (if provided) will be serialized into the snapshot, they can be used to re-initialize the state of the application or to re-acquire resources that the application needs when the application is restarted from the snapshot. @sin

46. [a:fs.d.ts:2651:fsync]
   name: fsync   (module fs)
   declaration: export function fsync(fd: number, callback: NoParamCallback): void;
   documentation: Request that all data for the open file descriptor is flushed to the storage device. The specific implementation is operating system and device specific. Refer to the POSIX [`fsync(2)`](http://man7.org/linux/man-pages/man2/fsync.2.html) documentation for more detail. No arguments other than a possible exception are given to the completion callback.

47. [a:tslib:lib.dom.d.ts:29774:RTCRtpSender.transform]
   name: transform   (member of RTCRtpSender)
   declaration: transform: RTCRtpSenderTransform | null;
   documentation: The **`transform`** property of the RTCRtpSender object is used to insert a transform stream (TransformStream) running in a worker thread into the sender pipeline. This allows stream transforms to be applied to encoded video and audio frames after they are output by a codec, and before they are sent. [MDN Reference](https://developer.mozilla.org/do

48. [a:stream/web.d.ts:209:ReadableStreamBYOBReader]
   name: ReadableStreamBYOBReader   (module stream/web)
   declaration: interface ReadableStreamBYOBReader extends ReadableStreamGenericReader {
   documentation: [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamBYOBReader)

49. [a:v8.d.ts:668:stopCoverage]
   name: stopCoverage   (module v8)
   declaration: function stopCoverage(): void;
   documentation: The `v8.stopCoverage()` method allows the user to stop the coverage collection started by `NODE_V8_COVERAGE`, so that V8 can release the execution count records and optimize code. This can be used in conjunction with {@link takeCoverage} if the user wants to collect the coverage on demand. @since v15.1.0, v14.18.0, v12.22.0

50. [a:tslib:lib.dom.d.ts:18937:HTMLInputElement.selectionDirection]
   name: selectionDirection   (member of HTMLInputElement)
   declaration: selectionDirection: SelectionDirection | null;
   documentation: The **`selectionDirection`** property of the HTMLInputElement interface is a string that indicates the direction in which the user is selecting the text. [MDN Reference](https://developer.mozilla.org/docs/Web/API/HTMLInputElement/selectionDirection)

51. [a:tslib:lib.dom.d.ts:5288:CSSCounterStyleRule.additiveSymbols]
   name: additiveSymbols   (member of CSSCounterStyleRule)
   declaration: additiveSymbols: string;
   documentation: The **`additiveSymbols`** property of the CSSCounterStyleRule interface gets and sets the value of the additive-symbols descriptor. If the descriptor does not have a value set, this attribute returns an empty string. [MDN Reference](https://developer.mozilla.org/docs/Web/API/CSSCounterStyleRule/additiveSymbols)

52. [a:tslib:lib.dom.d.ts:31885:SVGFEDiffuseLightingElement.in1]
   name: in1   (member of SVGFEDiffuseLightingElement)
   declaration: readonly in1: SVGAnimatedString;
   documentation: The **`in1`** read-only property of the SVGFEDiffuseLightingElement interface reflects the in attribute of the given <feDiffuseLighting> element. [MDN Reference](https://developer.mozilla.org/docs/Web/API/SVGFEDiffuseLightingElement/in1)

53. [a:fs/promises.d.ts:1063:mkdtempDisposable]
   name: mkdtempDisposable   (module fs/promises)
   declaration: function mkdtempDisposable(prefix: PathLike, options?: EncodingOption): Promise<DisposableTempDir>;
   documentation: The resulting Promise holds an async-disposable object whose `path` property holds the created directory path. When the object is disposed, the directory and its contents will be removed asynchronously if it still exists. If the directory cannot be deleted, disposal will throw an error. The object has an async `remove()` method which will perform t

54. [a:tslib:lib.dom.d.ts:9229:CSSStyleProperties.unicodeBidi]
   name: unicodeBidi   (member of CSSStyleProperties)
   declaration: unicodeBidi: string;
   documentation: The unicode-bidi CSS property, together with the direction property, determines how bidirectional text in a document is handled. For example, if a block of content contains both left-to-right and right-to-left text, the user-agent uses a complex Unicode algorithm to decide how to display the text. The unicode-bidi property overrides this algorithm 

55. [a:v8.d.ts:1000:setDeserializeMainFunction]
   name: setDeserializeMainFunction   (module v8)
   declaration: function setDeserializeMainFunction(callback: StartupSnapshotCallbackFn, data?: any): void;
   documentation: This sets the entry point of the Node.js application when it is deserialized from a snapshot. This can be called only once in the snapshot building script. If called, the deserialized application no longer needs an additional entry point script to start up and will simply invoke the callback along with the deserialized data (if provided), otherwise

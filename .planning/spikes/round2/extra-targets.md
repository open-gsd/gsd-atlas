# V2 additional targets

1. [a:inspector.generated.d.ts:338:StackTrace]
   name: StackTrace   (module inspector.generated)
   declaration: interface StackTrace {
   documentation: Call frames for assertions or error messages.

2. [a:tslib:lib.dom.d.ts:30430:RemotePlayback.onconnecting]
   name: onconnecting   (member of RemotePlayback)
   declaration: onconnecting: ((this: RemotePlayback, ev: Event) => any) | null;
   documentation: [MDN Reference](https://developer.mozilla.org/docs/Web/API/RemotePlayback/connecting_event)

3. [a:tslib:lib.dom.d.ts:6847:CSSStyleProperties.blockSize]
   name: blockSize   (member of CSSStyleProperties)
   declaration: blockSize: string;
   documentation: The block-size CSS property defines the size of an element's block along the block axis. If the writing-mode is horizontal, it corresponds to the height; if the writing mode is vertical, it corresponds to the width. A related property is inline-size, which defines the other dimension of the element. [MDN Reference](https://developer.mozilla.org/doc

4. [a:fs.d.ts:3559:WatchFileOptions]
   name: WatchFileOptions   (module fs)
   declaration: export interface WatchFileOptions {
   documentation: Watch for changes on `filename`. The callback `listener` will be called each time the file is accessed. The `options` argument may be omitted. If provided, it should be an object. The `options` object may contain a boolean named `persistent` that indicates whether the process should continue to run as long as files are being watched. The `options` 

5. [a:module.d.ts:835:NodeRequire]
   name: NodeRequire   (module module)
   declaration: interface NodeRequire extends NodeJS.Require {}
   documentation: @deprecated Use `NodeJS.Require` instead.

6. [a:crypto.d.ts:3876:verify]
   name: verify   (module crypto)
   declaration: function verify(
   documentation: Verifies the given signature for `data` using the given key and algorithm. If `algorithm` is `null` or `undefined`, then the algorithm is dependent upon the key type. `algorithm` is required to be `null` or `undefined` for Ed25519, Ed448, and ML-DSA. If `key` is not a `KeyObject`, this function behaves as if `key` had been passed to {@link createPu

7. [a:async_hooks.d.ts:206:createHook]
   name: createHook   (module async_hooks)
   declaration: function createHook(options: HookCallbacks): AsyncHook;
   documentation: Registers functions to be called for different lifetime events of each async operation. The callbacks `init()`/`before()`/`after()`/`destroy()` are called for the respective asynchronous event during a resource's lifetime. All callbacks are optional. For example, if only resource cleanup needs to be tracked, then only the `destroy` callback needs t

8. [a:tslib:lib.dom.d.ts:29835:RTCRtpTransceiver.currentDirection]
   name: currentDirection   (member of RTCRtpTransceiver)
   declaration: readonly currentDirection: RTCRtpTransceiverDirection | null;
   documentation: The read-only RTCRtpTransceiver property **`currentDirection`** is a string which indicates the current negotiated directionality of the transceiver. [MDN Reference](https://developer.mozilla.org/docs/Web/API/RTCRtpTransceiver/currentDirection)

9. [a:vm.d.ts:576:compileFunction]
   name: compileFunction   (module vm)
   declaration: function compileFunction(
   documentation: Compiles the given code into the provided context (if no context is supplied, the current context is used), and returns it wrapped inside a function with the given `params`. @since v10.10.0 @param code The body of the function to compile. @param params An array of strings containing all parameters for the function.

10. [a:tslib:lib.dom.d.ts:25074:MouseEvent.movementX]
   name: movementX   (member of MouseEvent)
   declaration: readonly movementX: number;
   documentation: The **`movementX`** read-only property of the MouseEvent interface provides the difference in the X coordinate of the mouse (or pointer) between the given move event and the previous move event of the same type. [MDN Reference](https://developer.mozilla.org/docs/Web/API/MouseEvent/movementX)

11. [a:tslib:lib.webworker.d.ts:4816:FileReaderSync.readAsArrayBuffer]
   name: readAsArrayBuffer   (member of FileReaderSync)
   declaration: readAsArrayBuffer(blob: Blob): ArrayBuffer;
   documentation: The **`readAsArrayBuffer()`** method of the FileReaderSync interface allows to read File or Blob objects in a synchronous way into an ArrayBuffer. This interface is only available in workers as it enables synchronous I/O that could potentially block. [MDN Reference](https://developer.mozilla.org/docs/Web/API/FileReaderSync/readAsArrayBuffer)

12. [a:tslib:lib.decorators.d.ts:96:ClassMethodDecoratorContext.access]
   name: access   (member of ClassMethodDecoratorContext)
   declaration: readonly access: {
   documentation: An object that can be used to access the current value of the class element at runtime.

13. [a:tslib:lib.dom.d.ts:28713:PublicKeyCredential.signalCurrentUserDetails]
   name: signalCurrentUserDetails   (member of PublicKeyCredential)
   declaration: signalCurrentUserDetails(options: CurrentUserDetailsOptions): Promise<void>;
   documentation: The **`signalCurrentUserDetails()`** static method of the PublicKeyCredential interface signals to the authenticator that a particular user has updated their user name and/or display name on the relying party (RP) server. [MDN Reference](https://developer.mozilla.org/docs/Web/API/PublicKeyCredential/signalCurrentUserDetails_static)

14. [a:tslib:lib.es5.d.ts:3244:Uint16Array.toString]
   name: toString   (member of Uint16Array)
   declaration: toString(): string;
   documentation: Returns a string representation of an array.

15. [a:fs.d.ts:4761:globSync]
   name: globSync   (module fs)
   declaration: export function globSync(pattern: string | readonly string[]): string[];
   documentation: When `followSymlinks` is enabled, detected symbolic link cycles are not traversed recursively.

16. [a:tslib:lib.dom.d.ts:42161:XPathEvaluator.XPathEvaluator]
   name: XPathEvaluator   (member of XPathEvaluator)
   declaration: interface XPathEvaluator extends XPathEvaluatorBase {
   documentation: The **`XPathEvaluator`** interface allows to compile and evaluate XPath expressions. [MDN Reference](https://developer.mozilla.org/docs/Web/API/XPathEvaluator)

17. [a:fs.d.ts:3508:appendFileSync]
   name: appendFileSync   (module fs)
   declaration: export function appendFileSync(
   documentation: Synchronously append data to a file, creating the file if it does not yet exist. `data` can be a string or a `Buffer`. The `mode` option only affects the newly created file. See {@link open} for more details.

18. [a:tslib:lib.dom.d.ts:42260:XPathResult.snapshotItem]
   name: snapshotItem   (member of XPathResult)
   declaration: snapshotItem(index: number): Node | null;
   documentation: The **`snapshotItem()`** method of the XPathResult interface returns an item of the snapshot collection or null in case the index is not within the range of nodes. Unlike the iterator result, the snapshot does not become invalid, but may not correspond to the current document if it is mutated. [MDN Reference](https://developer.mozilla.org/docs/Web/

19. [a:crypto.d.ts:2800:generateKeyPairSync]
   name: generateKeyPairSync   (module crypto)
   declaration: function generateKeyPairSync(
   documentation: Generates a new asymmetric key pair of the given `type`. See the supported [asymmetric key types](https://nodejs.org/docs/latest-v24.x/api/crypto.html#asymmetric-key-types). If a `publicKeyEncoding` or `privateKeyEncoding` was specified, this function behaves as if {@link KeyObject.export `keyObject.export()`} had been called on its result. Otherwi

20. [a:tslib:lib.decorators.d.ts:200:ClassSetterDecoratorContext.name]
   name: name   (member of ClassSetterDecoratorContext)
   declaration: readonly name: string | symbol;
   documentation: The name of the decorated class element.

21. [a:tls.d.ts:1057:checkServerIdentity]
   name: checkServerIdentity   (module tls)
   declaration: function checkServerIdentity(hostname: string, cert: PeerCertificate): Error | undefined;
   documentation: Verifies the certificate `cert` is issued to `hostname`. Returns [Error](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error) object, populating it with `reason`, `host`, and `cert` on failure. On success, returns [undefined](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Undefined_type). 

22. [a:fs.d.ts:546:Utf8Stream]
   name: Utf8Stream   (module fs)
   declaration: export class Utf8Stream extends EventEmitter {
   documentation: An optimized UTF-8 stream writer that allows for flushing all the internal buffering on demand. It handles `EAGAIN` errors correctly, allowing for customization, for example, by dropping content if the disk is busy. @since v24.6.0 @experimental

23. [a:util.d.ts:328:getCallSites]
   name: getCallSites   (module util)
   declaration: export function getCallSites(frameCount?: number, options?: GetCallSitesOptions): CallSiteObject[];
   documentation: Returns an array of call site objects containing the stack of the caller function. Unlike accessing an `error.stack`, the result returned from this API is not interfered with `Error.prepareStackTrace`.

24. [a:stream.d.ts:1434:finished]
   name: finished   (module stream)
   declaration: function finished(
   documentation: A readable and/or writable stream/webstream. A function to get notified when a stream is no longer readable, writable or has experienced an error or a premature close event.

25. [a:tslib:lib.dom.d.ts:8707:CSSStyleProperties.scrollMarginBottom]
   name: scrollMarginBottom   (member of CSSStyleProperties)
   declaration: scrollMarginBottom: string;
   documentation: The scroll-margin-bottom property defines the bottom margin of the scroll snap area that is used for snapping this box to the snapport. The scroll snap area is determined by taking the transformed border box, finding its rectangular bounding box (axis-aligned in the scroll container's coordinate space), then adding the specified outsets. [MDN Refer

26. [a:tslib:lib.es2019.symbol.d.ts:21:Symbol.description]
   name: description   (member of Symbol)
   declaration: readonly description: string | undefined;
   documentation: Expose the [[Description]] internal slot of a symbol directly.

27. [a:readline.d.ts:588:cursorTo]
   name: cursorTo   (module readline)
   declaration: export function cursorTo(stream: NodeJS.WritableStream, x: number, y?: number, callback?: () => void): boolean;
   documentation: The `readline.cursorTo()` method moves cursor to the specified position in a given [TTY](https://nodejs.org/docs/latest-v24.x/api/tty.html) `stream`. @since v0.7.7 @param callback Invoked once the operation completes. @return `false` if `stream` wishes for the calling code to wait for the `'drain'` event to be emitted before continuing to write add

28. [a:tslib:lib.dom.d.ts:18701:HTMLImageElement.useMap]
   name: useMap   (member of HTMLImageElement)
   declaration: useMap: string;
   documentation: The **`useMap`** property of the HTMLImageElement interface providing the name of the client-side image map to apply to the image. It reflects the <img> element's usemap content attribute. [MDN Reference](https://developer.mozilla.org/docs/Web/API/HTMLImageElement/useMap)

29. [a:tslib:lib.dom.d.ts:29481:RTCPeerConnection.pendingRemoteDescription]
   name: pendingRemoteDescription   (member of RTCPeerConnection)
   declaration: readonly pendingRemoteDescription: RTCSessionDescription | null;
   documentation: The **`pendingRemoteDescription`** read-only property of the RTCPeerConnection interface returns an RTCSessionDescription object describing a pending configuration change for the remote end of the connection. [MDN Reference](https://developer.mozilla.org/docs/Web/API/RTCPeerConnection/pendingRemoteDescription)

30. [a:stream.d.ts:1291:PassThrough]
   name: PassThrough   (module stream)
   declaration: class PassThrough extends Transform {}
   documentation: The `stream.PassThrough` class is a trivial implementation of a `Transform` stream that simply passes the input bytes across to the output. Its purpose is primarily for examples and testing, but there are some use cases where `stream.PassThrough` is useful as a building block for novel sorts of streams.

31. [a:tslib:lib.dom.d.ts:31566:SVGFEBlendElement.SVGFEBlendElement]
   name: SVGFEBlendElement   (member of SVGFEBlendElement)
   declaration: interface SVGFEBlendElement extends SVGElement, SVGFilterPrimitiveStandardAttributes {
   documentation: The **`SVGFEBlendElement`** interface corresponds to the <feBlend> element. [MDN Reference](https://developer.mozilla.org/docs/Web/API/SVGFEBlendElement)

32. [a:util.d.ts:2033:isFloat32Array]
   name: isFloat32Array   (module util)
   declaration: function isFloat32Array(object: unknown): object is Float32Array;
   documentation: Returns `true` if the value is a built-in [`Float32Array`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Float32Array) instance.

33. [a:http.d.ts:2190:validateHeaderValue]
   name: validateHeaderValue   (module http)
   declaration: function validateHeaderValue(name: string, value: string): void;
   documentation: Performs the low-level validations on the provided `value` that are done when `res.setHeader(name, value)` is called. Passing illegal value as `value` will result in a `TypeError` being thrown. * Undefined value error is identified by `code: 'ERR_HTTP_INVALID_HEADER_VALUE'`. * Invalid value character error is identified by `code: 'ERR_INVALID_CHAR'

34. [a:tslib:lib.dom.d.ts:20966:HTMLTableColElement.vAlign]
   name: vAlign   (member of HTMLTableColElement)
   declaration: vAlign: string;
   documentation: The **`vAlign`** property of the HTMLTableColElement interface is a string indicating how to vertically align text in a table <col> column element.

35. [a:zlib.d.ts:344:createDeflate]
   name: createDeflate   (module zlib)
   declaration: function createDeflate(options?: ZlibOptions): Deflate;
   documentation: Creates and returns a new `Deflate` object. @since v0.5.8

36. [a:tslib:lib.dom.d.ts:21281:HTMLTableSectionElement.vAlign]
   name: vAlign   (member of HTMLTableSectionElement)
   declaration: vAlign: string;
   documentation: The **`vAlign`** property of the HTMLTableSectionElement interface is a string indicating how to vertically align text in a <thead>, <tbody> or <tfoot> table section. Individual rows and cells can override it.

37. [a:zlib.d.ts:408:brotliDecompressSync]
   name: brotliDecompressSync   (module zlib)
   declaration: function brotliDecompressSync(buf: InputType, options?: BrotliOptions): NonSharedBuffer;
   documentation: Decompress a chunk of data with `BrotliDecompress`. @since v11.7.0, v10.16.0

38. [a:globals.d.ts:162:Iterator]
   name: Iterator   (module globals)
   declaration: interface Iterator<T, TReturn = undefined, TNext = any> extends IteratorObject<T, TReturn, TNext> {
   documentation: An iterable iterator returned by the Node.js API.

39. [a:stream/web.d.ts:332:WritableStreamDefaultWriter]
   name: WritableStreamDefaultWriter   (module stream/web)
   declaration: interface WritableStreamDefaultWriter<W = any> {
   documentation: This Streams API interface is the object returned by WritableStream.getWriter() and once created locks the < writer to the WritableStream ensuring that no other streams can write to the underlying sink.

40. [a:tslib:lib.dom.d.ts:33808:SVGSVGElement.createSVGPoint]
   name: createSVGPoint   (member of SVGSVGElement)
   declaration: createSVGPoint(): DOMPoint;
   documentation: The **`createSVGPoint()`** method of the SVGSVGElement interface creates a DOMPoint object outside of any document trees. [MDN Reference](https://developer.mozilla.org/docs/Web/API/SVGSVGElement/createSVGPoint)

41. [a:stream/consumers.d.ts:41:text]
   name: text   (module stream/consumers)
   declaration: function text(stream: WebReadableStream | NodeJS.ReadableStream | AsyncIterable<any>): Promise<string>;
   documentation: @since v16.7.0 @returns Fulfills with the contents of the stream parsed as a UTF-8 encoded string.

42. [a:util.d.ts:2141:isModuleNamespaceObject]
   name: isModuleNamespaceObject   (module util)
   declaration: function isModuleNamespaceObject(value: unknown): boolean;
   documentation: Returns `true` if the value is an instance of a [Module Namespace Object](https://tc39.github.io/ecma262/#sec-module-namespace-exotic-objects).

43. [a:util.d.ts:2022:isFloat16Array]
   name: isFloat16Array   (module util)
   declaration: function isFloat16Array(object: unknown): object is Float16Array;
   documentation: Returns `true` if the value is a built-in [`Float16Array`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Float16Array) instance.

44. [a:tslib:lib.dom.d.ts:21484:HTMLTextAreaElement.validity]
   name: validity   (member of HTMLTextAreaElement)
   declaration: readonly validity: ValidityState;
   documentation: The **`validity`** read-only property of the HTMLTextAreaElement interface returns a ValidityState object that represents the validity states this element is in. [MDN Reference](https://developer.mozilla.org/docs/Web/API/HTMLTextAreaElement/validity)

45. [a:crypto.d.ts:1803:createDiffieHellmanGroup]
   name: createDiffieHellmanGroup   (module crypto)
   declaration: function createDiffieHellmanGroup(name: string): DiffieHellmanGroup;
   documentation: An alias for {@link getDiffieHellman} @since v0.9.3

46. [a:tslib:lib.dom.d.ts:9235:CSSStyleProperties.userSelect]
   name: userSelect   (member of CSSStyleProperties)
   declaration: userSelect: string;
   documentation: The user-select CSS property controls whether the user can select text. This doesn't have any effect on content loaded as part of a browser's user interface (its chrome), except in textboxes. [MDN Reference](https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/user-select)

47. [a:tslib:lib.dom.d.ts:13514:Element.attributes]
   name: attributes   (member of Element)
   declaration: readonly attributes: NamedNodeMap;
   documentation: The **`Element.attributes`** property returns a live collection of all attribute nodes registered to the specified node. It is a NamedNodeMap, not an Array, so it has no Array methods and the Attr nodes' indexes may differ among browsers. To be more specific, attributes is a key/value pair of strings that represents any information regarding that a

48. [a:assert.d.ts:555:notDeepEqual]
   name: notDeepEqual   (module assert)
   declaration: function notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
   documentation: **Strict assertion mode** An alias of {@link notDeepStrictEqual}. **Legacy assertion mode** > Stability: 3 - Legacy: Use {@link notDeepStrictEqual} instead. Tests for any deep inequality. Opposite of {@link deepEqual}.

49. [a:tslib:lib.dom.d.ts:3614:Animation.pending]
   name: pending   (member of Animation)
   declaration: readonly pending: boolean;
   documentation: The read-only **`Animation.pending`** property of the Web Animations API indicates whether the animation is currently waiting for an asynchronous operation such as initiating playback or pausing a running animation. [MDN Reference](https://developer.mozilla.org/docs/Web/API/Animation/pending)

50. [a:util.d.ts:2353:isWeakMap]
   name: isWeakMap   (module util)
   declaration: function isWeakMap(object: unknown): object is WeakMap<object, unknown>;
   documentation: Returns `true` if the value is a built-in [`WeakMap`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap) instance.

51. [a:tslib:lib.dom.d.ts:12467:DeviceMotionEventRotationRate.DeviceMotionEventRotationRate]
   name: DeviceMotionEventRotationRate   (member of DeviceMotionEventRotationRate)
   declaration: interface DeviceMotionEventRotationRate {
   documentation: A **`DeviceMotionEventRotationRate`** interface of the Device Orientation Events provides information about the rate at which the device is rotating around all three axes. Available only in secure contexts. [MDN Reference](https://developer.mozilla.org/docs/Web/API/DeviceMotionEventRotationRate)

52. [a:tslib:lib.dom.d.ts:27332:PaymentRequestUpdateEvent.updateWith]
   name: updateWith   (member of PaymentRequestUpdateEvent)
   declaration: updateWith(detailsPromise: PaymentDetailsUpdate | PromiseLike<PaymentDetailsUpdate>): void;
   documentation: The **`updateWith()`** method of the PaymentRequestUpdateEvent interface updates the details of an existing PaymentRequest. [MDN Reference](https://developer.mozilla.org/docs/Web/API/PaymentRequestUpdateEvent/updateWith)

53. [a:tslib:lib.es5.d.ts:855:Date.setMinutes]
   name: setMinutes   (member of Date)
   declaration: setMinutes(min: number, sec?: number, ms?: number): number;
   documentation: Sets the minutes value in the Date object using local time.

54. [a:zlib.d.ts:486:inflateRawSync]
   name: inflateRawSync   (module zlib)
   declaration: function inflateRawSync(buf: InputType, options?: ZlibOptions): NonSharedBuffer;
   documentation: Decompress a chunk of data with `InflateRaw`. @since v0.11.12

55. [a:tslib:lib.dom.d.ts:20724:HTMLSourceElement.type]
   name: type   (member of HTMLSourceElement)
   declaration: type: string;
   documentation: The **`type`** property of the HTMLSourceElement interface is a string representing the MIME type of the media resource. [MDN Reference](https://developer.mozilla.org/docs/Web/API/HTMLSourceElement/type)

56. [a:stream/web.d.ts:381:ByteLengthQueuingStrategy]
   name: ByteLengthQueuingStrategy   (module stream/web)
   declaration: interface ByteLengthQueuingStrategy extends QueuingStrategy<ArrayBufferView> {
   documentation: This Streams API interface provides a built-in byte length queuing strategy that can be used when constructing streams.

57. [a:assert.d.ts:893:doesNotThrow]
   name: doesNotThrow   (module assert)
   declaration: function doesNotThrow(block: () => unknown, message?: string | Error): void;
   documentation: Asserts that the function `fn` does not throw an error. Using `assert.doesNotThrow()` is actually not useful because there is no benefit in catching an error and then rethrowing it. Instead, consider adding a comment next to the specific code path that should not throw and keep error messages as expressive as possible. When `assert.doesNotThrow()` 

58. [a:tslib:lib.dom.d.ts:38200:VisualViewport.VisualViewport]
   name: VisualViewport   (member of VisualViewport)
   declaration: interface VisualViewport extends EventTarget {
   documentation: The **`VisualViewport`** interface of the CSSOM view API represents the visual viewport for a given window. For a page containing iframes, each iframe, as well as the containing page, will have a unique window object. Each window on a page will have a unique VisualViewport representing the properties associated with that window. [MDN Reference](htt

59. [a:tslib:lib.dom.d.ts:6198:CSSPositionTryDescriptors.positionArea]
   name: positionArea   (member of CSSPositionTryDescriptors)
   declaration: positionArea: string;
   documentation: [MDN Reference](https://developer.mozilla.org/docs/Web/API/CSSPositionTryDescriptors#instance_properties)

60. [a:tslib:lib.dom.d.ts:5512:CSSImportRule.supportsText]
   name: supportsText   (member of CSSImportRule)
   declaration: readonly supportsText: string | null;
   documentation: The read-only **`supportsText`** property of the CSSImportRule interface returns the supports condition specified by the @import at-rule. [MDN Reference](https://developer.mozilla.org/docs/Web/API/CSSImportRule/supportsText)

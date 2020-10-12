// Copyright 2020 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
const getDataView = (() => {
    const cache = new WeakMap();
    return (buf) => {
        let dataView = cache.get(buf);
        if (!dataView) {
            dataView = new DataView(buf);
            cache.set(buf, dataView);
        }
        return dataView;
    };
})();
function std(name, size) {
    let get = DataView.prototype[`get${name}`];
    let set = DataView.prototype[`set${name}`];
    return {
        size,
        align: size,
        get(buf, ptr) {
            return get.call(getDataView(buf), ptr, true);
        },
        set(buf, ptr, value) {
            return set.call(getDataView(buf), ptr, value, true);
        }
    };
}
export const string = (() => {
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();
    return {
        get(buf, ptr, len) {
            return textDecoder.decode(new Uint8Array(buf, ptr, len));
        },
        set(buf, ptr, value, len = value.length) {
            let { read } = textEncoder.encodeInto(value, new Uint8Array(buf, ptr, len));
            if (read < value.length) {
                throw new Error(`Insufficient space.`);
            }
        }
    };
})();
function alignTo(ptr, align) {
    let mismatch = ptr % align;
    if (mismatch) {
        ptr += align - mismatch;
    }
    return ptr;
}
export function struct(desc) {
    class Ctor {
        constructor(_buf, _ptr) {
            this._buf = _buf;
            this._ptr = _ptr;
        }
    }
    let offset = 0;
    let structAlign = 0;
    for (let name in desc) {
        let type = desc[name];
        let fieldAlign = type.align;
        structAlign = Math.max(structAlign, fieldAlign);
        offset = alignTo(offset, fieldAlign);
        const fieldOffset = offset;
        Object.defineProperty(Ctor.prototype, name, {
            get() {
                return type.get(this._buf, (this._ptr + fieldOffset));
            },
            set(value) {
                type.set(this._buf, (this._ptr + fieldOffset), value);
            }
        });
        offset += type.size;
    }
    offset = alignTo(offset, structAlign);
    return {
        size: offset,
        align: structAlign,
        get(buf, ptr) {
            return new Ctor(buf, ptr);
        },
        set(buf, ptr, value) {
            Object.assign(new Ctor(buf, ptr), value);
        }
    };
}
export function taggedUnion({ tag: tagDesc, data: dataDesc }) {
    let unionSize = 0;
    let unionAlign = 0;
    for (let key in dataDesc) {
        let { size, align } = dataDesc[key];
        unionSize = Math.max(unionSize, size);
        unionAlign = Math.max(unionAlign, align);
    }
    unionSize = alignTo(unionSize, unionAlign);
    const unionOffset = alignTo(tagDesc.size, unionAlign);
    const totalAlign = Math.max(tagDesc.align, unionAlign);
    const totalSize = alignTo(unionOffset + unionSize, totalAlign);
    return {
        size: totalSize,
        align: totalAlign,
        get(buf, ptr) {
            let tag = tagDesc.get(buf, ptr);
            return {
                tag,
                data: dataDesc[tag].get(buf, (ptr + unionOffset))
            };
        },
        set(buf, ptr, value) {
            tagDesc.set(buf, ptr, value.tag);
            dataDesc[value.tag].set(buf, (ptr + unionOffset), value.data);
        }
    };
}
export function enumer(base) {
    // All the properties are same as for the underlying number, this wrapper is only useful at typechecking level.
    return base;
}
export const int8_t = std('Int8', 1);
export const uint8_t = std('Uint8', 1);
export const int16_t = std('Int16', 2);
export const uint16_t = std('Uint16', 2);
export const int32_t = std('Int32', 4);
export const uint32_t = std('Uint32', 4);
export const int64_t = std('bigint64', 8);
export const uint64_t = std('BigUint64', 8);
export const size_t = uint32_t;
//# sourceMappingURL=type-desc.js.map
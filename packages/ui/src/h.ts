// createElement под коротким именем: компоненты — в файлах .ts без JSX, тесты идут без сборки
// (research R15 фичи 004).
import { createElement, Fragment } from "react";

export const h = createElement;
export { Fragment };
